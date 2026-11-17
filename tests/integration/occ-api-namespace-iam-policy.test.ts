import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  AgentReadResponse,
  AgentResponse,
  ConfigurationResponse,
  ErrorResponse,
  IAMAccessBindingListResponse,
  IAMAccessBindingResponse,
  IAMRoleListResponse,
  IAMRoleResponse,
  NamespaceResponse,
  SecretResponse,
  type AccessBinding,
  type CreateIAMAccessBindingBody,
  type ErrorCode,
  type IAMDriver,
  type IAMManagedRoleInput,
  type Permission,
  type Role,
  type AuthorizationRequest,
  type ResourceRef,
} from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { BINDING_SUBJECT_EMAIL, BINDING_SUBJECT_INELIGIBLE } from "../helpers/refusal-text.mjs";
import {
  bootstrapInstallation,
  createInjectedControllerFixture,
  createNamespace,
  createReadyNamespace,
  identifier,
  injectedRequest,
  readyNamespaceFixture,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createInjectedControllerFixture>>;
type Reply = Awaited<ReturnType<FixtureRequest>>;
type BindingKind = CreateIAMAccessBindingBody["resourceKind"];

function checkedBody<Schema extends TSchema>(
  reply: Reply,
  status: number,
  schema: Schema,
  label?: string,
): Static<Schema> {
  const message =
    label === undefined ? JSON.stringify(reply.body) : `${label}: ${JSON.stringify(reply.body)}`;
  assert.equal(reply.status, status, message);
  assert(Check(schema, reply.body), message);
  return reply.body;
}

function assertApiError(reply: Reply, status: number, code: ErrorCode, label?: string) {
  const body = checkedBody(reply, status, ErrorResponse, label);
  assert.equal(body.error.code, code, JSON.stringify(body));
  return body;
}

async function configuredController() {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createInjectedControllerFixture(
    { auditSink },
    {
      wrapPlatformState: (state) => state,
      invokeApplication(factory, { backendSummaries, ...options }) {
        assert.equal(backendSummaries, undefined);
        return factory(options);
      },
    },
  );
  const request: FixtureRequest = (method, path, options) =>
    injectedRequest(fixture.app, method, path, options);
  return { fixture, request, auditSink };
}

type TestController = Awaited<ReturnType<typeof configuredController>>;

async function bootstrap(configured: TestController) {
  await bootstrapInstallation(configured);
  const { controller, platformState } = configured.fixture;
  assert(controller && platformState, "bootstrap must create OCC and its State");
  return { controller, platformState };
}

async function createConfiguration({ request }: TestController, namespaceId: string) {
  const values = {};
  const { data } = checkedBody(
    await request("POST", `/namespaces/${namespaceId}/configurations`, {
      body: { kind: "agent", values },
    }),
    201,
    ConfigurationResponse,
  );
  assert.match(data.id, identifier("cfg"));
  assert.equal(data.namespaceId, namespaceId);
  assert.deepEqual(data.values, values);
  return data;
}

async function createAgent(controller: TestController, namespaceId: string, name: string) {
  const configuration = await createConfiguration(controller, namespaceId);
  const { data } = checkedBody(
    await controller.request("POST", `/namespaces/${namespaceId}/agents`, {
      body: { name, configurationId: configuration.id },
    }),
    201,
    AgentResponse,
  );
  assert.equal(data.name, name);
  assert.equal(data.namespaceId, namespaceId);
  assert.match(data.id, identifier("agt"));
  assert.equal(data.configurationId, configuration.id);
  assert.equal(Object.hasOwn(data, "installationId"), false);
  assert.equal(typeof data.servicePrincipalId, "string");
  assert.ok(data.servicePrincipalId.length > 0);
  return data;
}

test("Namespace IAM routes manage exact Role and AccessBinding policy through the selected Driver", async () => {
  const { controller, fixture, namespace } = await readyNamespaceFixture(
    await configuredController(),
    "iam-policy",
  );
  const secret = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "Model API key", value: "iam-policy-secret" },
  });
  const { data: secretData } = checkedBody(secret, 201, SecretResponse);
  const agent = await createAgent(controller, namespace.id, "iam-policy-agent");

  const role = await controller.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
    body: {
      name: "Secret operator",
      permissions: [{ action: "operate", resourceKind: "secret" }],
    },
  });
  const { data: roleData } = checkedBody(role, 201, IAMRoleResponse);
  assert.match(roleData.id, identifier("role"));
  assert.deepEqual(roleData, {
    id: roleData.id,
    namespaceId: namespace.id,
    name: "Secret operator",
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });

  const roles = await controller.request("GET", `/namespaces/${namespace.id}/iam/roles`);
  const { data: rolesData } = checkedBody(roles, 200, IAMRoleListResponse);
  assert.deepEqual(rolesData, [roleData]);

  const roleDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/roles/${roleData.id}`,
  );
  const { data: roleDetailData } = checkedBody(roleDetail, 200, IAMRoleResponse);
  assert.deepEqual(roleDetailData, roleData);

  const binding = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/iam/access-bindings`,
    {
      body: {
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: roleData.id,
        resourceKind: "secret",
        resourceId: secretData.id,
      },
    },
  );
  const { data: bindingData } = checkedBody(binding, 201, IAMAccessBindingResponse);
  assert.match(bindingData.id, identifier("binding"));
  assert.deepEqual(bindingData, {
    id: bindingData.id,
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: roleData.id,
    resourceKind: "secret",
    resourceId: secretData.id,
  });

  const bindings = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/access-bindings`,
  );
  const { data: bindingsData } = checkedBody(bindings, 200, IAMAccessBindingListResponse);
  assert.deepEqual(bindingsData, [bindingData]);

  const bindingDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/access-bindings/${bindingData.id}`,
  );
  const { data: bindingDetailData } = checkedBody(bindingDetail, 200, IAMAccessBindingResponse);
  assert.deepEqual(bindingDetailData, bindingData);

  const referencedDelete = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/iam/roles/${roleData.id}`,
  );
  assertApiError(referencedDelete, 409, "RESOURCE_CONFLICT");

  const deletedBinding = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/iam/access-bindings/${bindingData.id}`,
  );
  assert.equal(deletedBinding.status, 204);

  const deletedRole = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/iam/roles/${roleData.id}`,
  );
  assert.equal(deletedRole.status, 204);

  const missingRole = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/roles/${roleData.id}`,
  );
  assertApiError(missingRole, 404, "NOT_FOUND");

  // Each policy mutation records what changed, and its authorization names the
  // Installation administer check the controller actually makes.
  const policyEvents = new Map(
    controller.auditSink.events
      .filter((event) => event.kind === "mutation" && event.action.startsWith("openclaw.iam."))
      .map((event) => [event.action, event]),
  );
  const installationAuthorization: AuthorizationRequest = {
    principalId: fixture.principal.id,
    action: "administer",
    resource: { kind: "installation", id: fixture.installationId },
  };
  const namespaceResource: ResourceRef = {
    kind: "namespace",
    id: namespace.id,
    namespaceId: namespace.id,
  };
  const secretResource: ResourceRef = {
    kind: "secret",
    id: secretData.id,
    namespaceId: namespace.id,
  };
  const roleDetails = {
    roleId: roleData.id,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  };
  const bindingDetails = {
    bindingId: bindingData.id,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: roleData.id,
  };
  for (const [action, resource, details] of [
    ["openclaw.iam.roles.create", namespaceResource, roleDetails],
    ["openclaw.iam.access_bindings.create", secretResource, bindingDetails],
    ["openclaw.iam.access_bindings.delete", secretResource, bindingDetails],
    ["openclaw.iam.roles.delete", namespaceResource, roleDetails],
  ] as const) {
    const recorded = policyEvents.get(action);
    assert.ok(recorded, action);
    assert.equal(recorded.outcome, "success", action);
    assert.deepEqual(recorded.resource, resource, action);
    assert.deepEqual(recorded.authorization, installationAuthorization, action);
    assert.deepEqual(recorded.details, details, action);
  }
});

test("Namespace IAM routes bind existing humans to the exact Namespace and Agent", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  const member = await fixture.createAuthPrincipal("assigned-member");
  fixture.state.identities.push(member.principal);
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "human-iam");
  const foreign = await createNamespace(controller, "foreign-human-iam");
  const agent = await createAgent(controller, namespace.id, "assigned-agent");
  const foreignAgent = await createAgent(controller, foreign.id, "foreign-agent");
  const role = await controller.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
    body: {
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
      ],
    },
  });
  const { data: roleData } = checkedBody(role, 201, IAMRoleResponse);

  const bind = (subjectId: string, resourceKind: BindingKind, resourceId: string) =>
    controller.request("POST", `/namespaces/${namespace.id}/iam/access-bindings`, {
      body: { subjectKind: "identity", subjectId, roleId: roleData.id, resourceKind, resourceId },
    });
  // A provisioned human has no Namespace ServicePrincipal entry.
  for (const [resourceKind, resourceId] of [
    ["namespace", namespace.id],
    ["agent", agent.id],
  ] as const) {
    const binding = await bind(member.principal.id, resourceKind, resourceId);
    const { data: bindingData } = checkedBody(binding, 201, IAMAccessBindingResponse);
    assert.equal(bindingData.subjectId, member.principal.id);
    assert("resourceKind" in bindingData, "the binding must name an exact target");
    assert.equal(bindingData.resourceKind, resourceKind);
    assert.equal(bindingData.resourceId, resourceId);
  }

  for (const [subjectId, resourceKind, resourceId] of [
    ["missing-human", "namespace", namespace.id],
    [foreignAgent.servicePrincipalId, "namespace", namespace.id],
    [member.principal.id, "namespace", foreign.id],
    [member.principal.id, "namespace", `ns_${randomUUID()}`],
    [member.principal.id, "agent", foreignAgent.id],
    [member.principal.id, "agent", namespace.id],
  ] as const) {
    const denied = await bind(subjectId, resourceKind, resourceId);
    assertApiError(denied, 400, "INVALID_REQUEST");
  }

  const memberApp = fixture.createApp(member.principal);
  const forbidden = await injectedRequest(
    memberApp,
    "POST",
    `/namespaces/${namespace.id}/iam/roles`,
    {
      body: { permissions: [{ action: "read", resourceKind: "namespace" }] },
    },
  );
  const { meta } = assertApiError(
    forbidden,
    403,
    "FORBIDDEN",
    "human grants must not confer policy administration",
  );
  const denial = controller.auditSink.events.find(
    (event) => event.kind === "authorization_denial" && event.requestId === meta.requestId,
  );
  assert(denial);
  assert.equal(denial.actorId, member.principal.id);
  const bindings = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/access-bindings`,
  );
  const { data: bindingsData } = checkedBody(bindings, 200, IAMAccessBindingListResponse);
  assert.equal(bindingsData.length, 2, "rejected grants must leave policy unchanged");
});

test("Namespace IAM refuses bindings whose Role cannot apply to the target", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  const member = await fixture.createAuthPrincipal("inapplicable-role-member");
  fixture.state.identities.push(member.principal);
  const { platformState } = await bootstrap(controller);
  const namespace = await createNamespace(controller, "inapplicable-role");
  const agent = await createAgent(controller, namespace.id, "inapplicable-role-agent");
  const createRole = async (permissions: readonly Permission[]) => {
    const role = await controller.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
      body: { permissions },
    });
    const { data: roleData } = checkedBody(role, 201, IAMRoleResponse);
    return roleData.id;
  };
  const bind = (roleId: string, resourceKind: BindingKind, resourceId: string) =>
    controller.request("POST", `/namespaces/${namespace.id}/iam/access-bindings`, {
      body: {
        subjectKind: "identity",
        subjectId: member.principal.id,
        roleId,
        resourceKind,
        resourceId,
      },
    });

  // Role creation now refuses create Permissions, but Roles stored before that refusal can
  // still hold them; write one straight to the policy State, as the earlier API did.
  // Binding it is the dogfood "share the Namespace" attempt: create is authorized against
  // the Namespace, never an exact resource, so these Permissions would be silently dropped
  // at evaluation.
  const storedRole = async (id: string, permissions: readonly Permission[]) => {
    await platformState.transact((unit) =>
      unit.iamPolicy.createRole({ id, namespaceId: namespace.id, permissions }),
    );
    return id;
  };
  const creator = await storedRole(`role_${randomUUID()}`, [
    { action: "read", resourceKind: "namespace" },
    { action: "create", resourceKind: "agent" },
    { action: "create", resourceKind: "configuration" },
    { action: "create", resourceKind: "secret" },
  ]);
  for (const [resourceKind, resourceId] of [
    ["namespace", namespace.id],
    ["agent", agent.id],
  ] as const) {
    const rejected = await bind(creator, resourceKind, resourceId);
    const { error: rejectedError } = assertApiError(rejected, 400, "INVALID_REQUEST");
    assert.deepEqual(rejectedError.details, [{ path: "/roleId", code: "INVALID_VALUE" }]);
    assert.match(
      rejectedError.message,
      /^Role role_\S+ has Permissions this API cannot bind: agent:create, configuration:create, secret:create\. Create is checked on the Namespace, and this API binds only exact resources; bind a Role without them\.$/,
    );
  }

  // A long list of create Permissions is shortened so the guidance still fits the cap.
  const manyCreates = await storedRole(
    `role_${randomUUID()}`,
    (
      [
        "agent",
        "configuration",
        "credential_source",
        "preset",
        "secret",
        "service_account",
      ] satisfies BindingKind[]
    ).map((resourceKind) => ({ action: "create", resourceKind })),
  );
  const long = await bind(manyCreates, "namespace", namespace.id);
  const { error: longError } = assertApiError(long, 400, "INVALID_REQUEST");
  assert.ok(Array.from(longError.message).length <= 256, longError.message);
  assert.match(longError.message, / and \d+ more\. .*bind a Role without them\.$/);

  // A stored create Role stays readable and deletable, so an administrator can replace it.
  const policyPath = `/namespaces/${namespace.id}/iam/roles`;
  const listed = await controller.request("GET", policyPath);
  const { data: listedData } = checkedBody(listed, 200, IAMRoleListResponse);
  assert.ok(
    listedData.some((role) => role.id === creator),
    "stored create Roles must still be listed",
  );
  const read = await controller.request("GET", `${policyPath}/${creator}`);
  const { data: readData } = checkedBody(read, 200, IAMRoleResponse);
  assert.deepEqual(
    readData.permissions.filter((permission) => permission.action === "create"),
    [
      { action: "create", resourceKind: "agent" },
      { action: "create", resourceKind: "configuration" },
      { action: "create", resourceKind: "secret" },
    ],
  );
  const removed = await controller.request("DELETE", `${policyPath}/${creator}`);
  assert.equal(removed.status, 204, JSON.stringify(removed.body));

  // A Role with no Permission for the target's kind would grant nothing there.
  const agentReader = await createRole([{ action: "read", resourceKind: "agent" }]);
  const nothing = await bind(agentReader, "namespace", namespace.id);
  const { error: nothingError } = assertApiError(nothing, 400, "INVALID_REQUEST");
  assert.match(nothingError.message, /grants nothing on the namespace target.*agent:read/);

  // The same Role still binds to a target its Permissions name.
  const granted = await bind(agentReader, "agent", agent.id);
  const { data: grantedData } = checkedBody(granted, 201, IAMAccessBindingResponse);
  const bindings = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/access-bindings`,
  );
  const { data: bindingsData } = checkedBody(bindings, 200, IAMAccessBindingListResponse);
  assert.deepEqual(
    bindingsData.map((binding) => binding.id),
    [grantedData.id],
    "refused bindings must leave policy unchanged",
  );
});

test("Namespace IAM routes bind humans enrolled after bootstrap through the live resolver", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "late-enrolled-iam");
  const foreign = await createNamespace(controller, "late-enrolled-foreign");
  const agent = await createAgent(controller, namespace.id, "late-enrolled-agent");
  const foreignAgent = await createAgent(controller, foreign.id, "late-enrolled-foreign-agent");
  const role = await controller.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
    body: {
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
      ],
    },
  });
  const { data: roleData } = checkedBody(role, 201, IAMRoleResponse);
  const bind = (subjectId: string, resourceKind: BindingKind, resourceId: string) =>
    controller.request("POST", `/namespaces/${namespace.id}/iam/access-bindings`, {
      body: { subjectKind: "identity", subjectId, roleId: roleData.id, resourceKind, resourceId },
    });

  // Enrolled after the controller and its State were built.
  const member = await fixture.createAuthPrincipal("late-enrolled-member");
  fixture.state.identities.push(member.principal);
  const localService = `sp_${randomUUID()}`;
  const foreignService = `sp_${randomUUID()}`;
  const installationService = `sp_${randomUUID()}`;
  fixture.state.identities.push(
    { kind: "service_principal", id: localService, namespaceId: namespace.id },
    { kind: "service_principal", id: foreignService, namespaceId: foreign.id },
    { kind: "service_principal", id: installationService },
  );

  for (const [subjectId, resourceKind, resourceId] of [
    [member.principal.id, "namespace", namespace.id],
    [member.principal.id, "agent", agent.id],
    [localService, "namespace", namespace.id],
    [agent.servicePrincipalId, "namespace", namespace.id],
  ] as const) {
    const binding = await bind(subjectId, resourceKind, resourceId);
    const { data: bindingData } = checkedBody(binding, 201, IAMAccessBindingResponse);
    assert.equal(bindingData.subjectId, subjectId);
  }

  for (const [subjectId, resourceKind, resourceId] of [
    [`prn_${randomUUID()}`, "namespace", namespace.id],
    [foreignService, "namespace", namespace.id],
    [installationService, "namespace", namespace.id],
    [foreignAgent.servicePrincipalId, "namespace", namespace.id],
    [member.principal.id, "namespace", foreign.id],
    [member.principal.id, "namespace", `ns_${randomUUID()}`],
    [member.principal.id, "agent", foreignAgent.id],
  ] as const) {
    const denied = await bind(subjectId, resourceKind, resourceId);
    assertApiError(denied, 400, "INVALID_REQUEST", subjectId);
  }
  const bindings = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/access-bindings`,
  );
  const { data: bindingsData } = checkedBody(bindings, 200, IAMAccessBindingListResponse);
  assert.equal(bindingsData.length, 4, "rejected subjects must leave policy unchanged");
});

test("access removed by deleting its target or Namespace is audited and leaves no policy behind", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  const member = await fixture.createAuthPrincipal("side-effect-member");
  fixture.state.identities.push(member.principal);
  const { controller: occ } = await bootstrap(controller);
  const namespace = await createReadyNamespace(controller, "side-effect-access");
  const secret = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "Side effect key", value: "side-effect-secret" },
  });
  const { data: secretData } = checkedBody(secret, 201, SecretResponse);
  const configuration = await createConfiguration(controller, namespace.id);
  const agent = await createAgent(controller, namespace.id, "side-effect-agent");
  const policyPath = `/namespaces/${namespace.id}/iam`;
  const role = await controller.request("POST", `${policyPath}/roles`, {
    body: {
      permissions: [
        { action: "read", resourceKind: "secret" },
        { action: "read", resourceKind: "configuration" },
        { action: "delete", resourceKind: "agent" },
      ],
    },
  });
  const { data: roleData } = checkedBody(role, 201, IAMRoleResponse);
  const bind = async (resourceKind: BindingKind, resourceId: string) => {
    const binding = await controller.request("POST", `${policyPath}/access-bindings`, {
      body: {
        subjectKind: "identity",
        subjectId: member.principal.id,
        roleId: roleData.id,
        resourceKind,
        resourceId,
      },
    });
    const { data: bindingData } = checkedBody(binding, 201, IAMAccessBindingResponse);
    return bindingData;
  };
  const secretBinding = await bind("secret", secretData.id);
  const configurationBinding = await bind("configuration", configuration.id);
  const agentBinding = await bind("agent", agent.id);
  const removedEntry = (binding: IAMAccessBindingResponse["data"]) => {
    assert("resourceKind" in binding, "the removed binding must name an exact target");
    return {
      id: binding.id,
      subjectKind: "identity",
      subjectId: member.principal.id,
      roleId: roleData.id,
      resourceKind: binding.resourceKind,
      resourceId: binding.resourceId,
    };
  };
  const lastDetails = (action: string) => {
    const event = [...controller.auditSink.events]
      .reverse()
      .find((event) => event.action === action);
    assert(event?.details, action);
    return event.details;
  };

  assert.equal(
    (await controller.request("DELETE", `/namespaces/${namespace.id}/secrets/${secretData.id}`))
      .status,
    204,
  );
  assert.deepEqual(lastDetails("openclaw.secrets.delete").removedAccessBindings, [
    removedEntry(secretBinding),
  ]);
  assert.equal(
    (
      await controller.request(
        "DELETE",
        `/namespaces/${namespace.id}/configurations/${configuration.id}`,
      )
    ).status,
    204,
  );
  assert.deepEqual(lastDetails("openclaw.configurations.delete").removedAccessBindings, [
    removedEntry(configurationBinding),
  ]);
  const deleting = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
  assert.deepEqual(lastDetails("openclaw.agents.delete").accessBindingsRemovedOnCompletion, [
    removedEntry(agentBinding),
  ]);

  // A Namespace tombstone keeps none of its own Roles or AccessBindings.
  const empty = await createReadyNamespace(controller, "side-effect-empty");
  const reader = await controller.request("POST", `/namespaces/${empty.id}/iam/roles`, {
    body: { permissions: [{ action: "read", resourceKind: "namespace" }] },
  });
  const { data: readerData } = checkedBody(reader, 201, IAMRoleResponse);
  const unused = await controller.request("POST", `/namespaces/${empty.id}/iam/roles`, {
    body: { permissions: [{ action: "read", resourceKind: "agent" }] },
  });
  const { data: unusedData } = checkedBody(unused, 201, IAMRoleResponse);
  const readerBinding = await controller.request(
    "POST",
    `/namespaces/${empty.id}/iam/access-bindings`,
    {
      body: {
        subjectKind: "identity",
        subjectId: member.principal.id,
        roleId: readerData.id,
        resourceKind: "namespace",
        resourceId: empty.id,
      },
    },
  );
  const { data: readerBindingData } = checkedBody(readerBinding, 201, IAMAccessBindingResponse);
  assert.equal((await controller.request("DELETE", `/namespaces/${empty.id}`)).status, 202);
  await occ.handleNamespaceLifecycle(fixture.principal.id, empty.id, "deleted");
  assert.equal((await controller.request("GET", `/namespaces/${empty.id}`)).status, 404);
  const remaining = await occ.transact(async (unit) => ({
    bindings: await unit.iamPolicy.listAccessBindings(empty.id),
    roles: await unit.iamPolicy.listRoles(empty.id),
  }));
  assert.deepEqual(remaining, { bindings: [], roles: [] });
  const teardown = [...controller.auditSink.events]
    .reverse()
    .find(
      (event) =>
        event.action === "openclaw.namespaces.lifecycle.delete" && event.resource.id === empty.id,
    );
  assert(teardown?.details);
  assert.equal(teardown.outcome, "success");
  assert.deepEqual(teardown.details.removedAccessBindings, [
    {
      id: readerBindingData.id,
      subjectKind: "identity",
      subjectId: member.principal.id,
      roleId: readerData.id,
      resourceKind: "namespace",
      resourceId: empty.id,
    },
  ]);
  const { removedRoleIds } = teardown.details;
  assert(Check(Type.Array(Type.String()), removedRoleIds));
  assert.deepEqual([...removedRoleIds].sort(), [readerData.id, unusedData.id].sort());
});

test("Namespace IAM reports invalid policy input as 400 with the field and refuses inert Permissions", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  const member = await fixture.createAuthPrincipal("policy-validation-member");
  fixture.state.identities.push(member.principal);
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "policy-validation");
  const other = await createNamespace(controller, "policy-validation-other");
  const createRole = (namespaceId: string, permissions: readonly Permission[]) =>
    controller.request("POST", `/namespaces/${namespaceId}/iam/roles`, {
      body: { permissions },
    });

  // Pairs that no operation checks would be stored and grant nothing.
  for (const [action, resourceKind] of [
    ["read_logs", "secret"],
    ["administer", "secret"],
    ["deploy", "configuration"],
    ["update", "agent_revision"],
    ["operate", "preset"],
  ] as const) {
    const rejected = await createRole(namespace.id, [
      { action: "read", resourceKind: "agent" },
      { action, resourceKind },
    ]);
    const { error: rejectedError } = assertApiError(rejected, 400, "INVALID_REQUEST");
    assert.deepEqual(rejectedError.details, [{ path: "/permissions", code: "INVALID_VALUE" }]);
    assert.match(rejectedError.message, new RegExp(`grant nothing: ${resourceKind}:${action}\\.`));
  }
  // A Role naming many of them gets a message within the 256-character error contract.
  const kinds = [
    "agent_revision",
    "configuration",
    "credential_source",
    "preset",
    "secret",
  ] as const;
  const actions = [
    "administer",
    "create",
    "delete",
    "deploy",
    "operate",
    "read_logs",
    "update",
  ] as const;
  const many = await createRole(
    namespace.id,
    kinds.flatMap((resourceKind) => actions.map((action) => ({ action, resourceKind }))),
  );
  const { error: manyError } = assertApiError(many, 400, "INVALID_REQUEST");
  assert.deepEqual(manyError.details, [{ path: "/permissions", code: "INVALID_VALUE" }]);
  assert.ok(Array.from(manyError.message).length <= 256, manyError.message);
  assert.match(
    manyError.message,
    /^No operation checks these Permissions, so they would grant nothing: agent_revision:administer, .* and \d+ more\. See the per-kind actions in the permissions reference\.$/,
  );
  const duplicate = await createRole(namespace.id, [
    { action: "read", resourceKind: "agent" },
    { action: "read", resourceKind: "agent" },
  ]);
  const { error: duplicateError } = assertApiError(duplicate, 400, "INVALID_REQUEST");
  assert.deepEqual(duplicateError.details, [{ path: "/permissions/1", code: "INVALID_VALUE" }]);
  assert.match(duplicateError.message, /agent:read more than once/);
  const lifecycle = await createRole(namespace.id, [
    { action: "delete", resourceKind: "namespace" },
  ]);
  const { error: lifecycleError } = assertApiError(lifecycle, 400, "INVALID_REQUEST");
  assert.deepEqual(lifecycleError.details, [
    { path: "/permissions/0/action", code: "INVALID_VALUE" },
  ]);
  // create is checked on the Namespace collection and this API binds only exact resources,
  // so every binding of such a Role would be refused; Role creation refuses it first and
  // points at the first create Permission.
  const createKinds = [
    "agent",
    "configuration",
    "credential_source",
    "preset",
    "secret",
    "service_account",
  ] as const;
  for (const resourceKind of createKinds) {
    for (const [permissions, index] of [
      [[{ action: "create", resourceKind }], 0],
      [
        [
          { action: "read", resourceKind },
          { action: "create", resourceKind },
        ],
        1,
      ],
    ] as const) {
      const rejected = await createRole(namespace.id, permissions);
      const { error: rejectedError } = assertApiError(rejected, 400, "INVALID_REQUEST");
      assert.deepEqual(rejectedError.details, [
        { path: `/permissions/${index}/action`, code: "INVALID_VALUE" },
      ]);
      assert.equal(
        rejectedError.message,
        `Namespace IAM Roles cannot grant create Permissions: ${resourceKind}:create. Create is checked on the Namespace, and this API binds only exact resources; omit them from the Role.`,
      );
    }
  }
  const allCreates = await createRole(namespace.id, [
    { action: "read", resourceKind: "agent" },
    ...createKinds.map((resourceKind): Permission => ({ action: "create", resourceKind })),
  ]);
  const { error: allCreatesError } = assertApiError(allCreates, 400, "INVALID_REQUEST");
  assert.deepEqual(allCreatesError.details, [
    { path: "/permissions/1/action", code: "INVALID_VALUE" },
  ]);
  assert.ok(Array.from(allCreatesError.message).length <= 256, allCreatesError.message);
  assert.match(
    allCreatesError.message,
    /^Namespace IAM Roles cannot grant create Permissions: agent:create, .* and \d+ more\. .*omit them from the Role\.$/,
  );
  const roles = await controller.request("GET", `/namespaces/${namespace.id}/iam/roles`);
  const { data: rolesData } = checkedBody(roles, 200, IAMRoleListResponse);
  assert.deepEqual(rolesData, [], "rejected Roles must not be persisted");

  // Every supported pair is still accepted.
  const supported = await createRole(namespace.id, [
    { action: "read", resourceKind: "namespace" },
    { action: "operate", resourceKind: "secret" },
    { action: "read_logs", resourceKind: "agent" },
    { action: "administer", resourceKind: "agent" },
    { action: "read", resourceKind: "agent_revision" },
    { action: "operate", resourceKind: "credential_source" },
  ]);
  assert.equal(supported.status, 201, JSON.stringify(supported.body));
  const reader = await createRole(namespace.id, [{ action: "read", resourceKind: "namespace" }]);
  const { data: readerData } = checkedBody(reader, 201, IAMRoleResponse);
  const foreignRole = await createRole(other.id, [{ action: "read", resourceKind: "namespace" }]);
  const { data: foreignRoleData } = checkedBody(foreignRole, 201, IAMRoleResponse);

  const bind = (body: Partial<CreateIAMAccessBindingBody>) =>
    controller.request("POST", `/namespaces/${namespace.id}/iam/access-bindings`, {
      body: {
        subjectKind: "identity",
        subjectId: member.principal.id,
        roleId: readerData.id,
        resourceKind: "namespace",
        resourceId: namespace.id,
        ...body,
      },
    });
  for (const [body, path] of [
    [{ resourceId: other.id }, "/resourceId"],
    [{ roleId: foreignRoleData.id }, "/roleId"],
    [{ roleId: `role_${randomUUID()}` }, "/roleId"],
    [{ subjectId: `prn_${randomUUID()}` }, "/subjectId"],
  ] as const) {
    const rejected = await bind(body);
    const { error: rejectedError } = assertApiError(rejected, 400, "INVALID_REQUEST", path);
    assert.deepEqual(rejectedError.details, [{ path, code: "INVALID_VALUE" }]);
  }
  // An email is the caller's own input, so the answer names that mistake; an unknown principal ID
  // keeps the answer an ineligible one gets, so it reveals no principal (finding D753).
  const email = await bind({ subjectId: "nora@example.com" });
  const { error: emailError } = assertApiError(email, 400, "INVALID_REQUEST", "/subjectId");
  assert.equal(emailError.message, BINDING_SUBJECT_EMAIL);
  const unknown = await bind({ subjectId: `prn_${randomUUID()}` });
  const { error: unknownError } = assertApiError(unknown, 400, "INVALID_REQUEST");
  assert.equal(unknownError.message, BINDING_SUBJECT_INELIGIBLE);

  // A Role still referenced by an AccessBinding names the reason, not "already exists".
  const binding = await bind({});
  assert.equal(binding.status, 201, JSON.stringify(binding.body));
  const inUse = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/iam/roles/${readerData.id}`,
  );
  const { error: inUseError } = assertApiError(inUse, 409, "RESOURCE_CONFLICT");
  assert.match(inUseError.message, /referenced by AccessBindings/);
});

test("Namespace IAM Roles cannot grant Namespace lifecycle actions to a Namespace binding", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  const member = await fixture.createAuthPrincipal("namespace-escalation-member");
  fixture.state.identities.push(member.principal);
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "namespace-read-only-grant");
  const createRole = (permissions: readonly Permission[]) =>
    controller.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
      body: { permissions },
    });
  for (const action of [
    "create",
    "update",
    "delete",
    "deploy",
    "operate",
    "administer",
    "read_logs",
  ] as const) {
    const rejected = await createRole([
      { action: "read", resourceKind: "namespace" },
      { action, resourceKind: "namespace" },
    ]);
    assertApiError(rejected, 400, "INVALID_REQUEST");
  }
  const roles = await controller.request("GET", `/namespaces/${namespace.id}/iam/roles`);
  const { data: rolesData } = checkedBody(roles, 200, IAMRoleListResponse);
  assert.deepEqual(rolesData, [], "rejected Namespace Roles must not be persisted");

  const reader = await createRole([{ action: "read", resourceKind: "namespace" }]);
  const { data: readerData } = checkedBody(reader, 201, IAMRoleResponse);
  const binding = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/iam/access-bindings`,
    {
      body: {
        subjectKind: "identity",
        subjectId: member.principal.id,
        roleId: readerData.id,
        resourceKind: "namespace",
        resourceId: namespace.id,
      },
    },
  );
  const { data: bindingData } = checkedBody(binding, 201, IAMAccessBindingResponse);
  // Mirror persisted policy into the native IAM state, as production loadNativeIAMState does.
  fixture.state.roles.push(readerData);
  fixture.state.bindings.push(bindingData);

  const memberApp = fixture.createApp(member.principal);
  const read = await injectedRequest(memberApp, "GET", `/namespaces/${namespace.id}`);
  const { data: readData } = checkedBody(read, 200, NamespaceResponse);
  const deletion = await injectedRequest(memberApp, "DELETE", `/namespaces/${namespace.id}`);
  assert.equal(deletion.status, 403, JSON.stringify(deletion.body));
  const after = await controller.request("GET", `/namespaces/${namespace.id}`);
  const { data: afterData } = checkedBody(after, 200, NamespaceResponse);
  assert.equal(afterData.status, readData.status, "the Namespace must not enter deletion");
});

function createPermissiveIAMDriver(
  fixture: Fixture,
  { id, implementation, reason }: Pick<IAMDriver, "id" | "implementation"> & { reason: string },
): IAMDriver {
  return {
    id,
    capability: "iam",
    implementation,
    async lookupIdentity(input) {
      if (
        input.issuer === fixture.principal.issuer &&
        input.subject === fixture.principal.subject
      ) {
        return fixture.principal;
      }
      return undefined;
    },
    async authorize(request) {
      return {
        allowed: true,
        reason,
        driverId: id,
        evidence: {
          identityId: request.principalId,
          groupIds: [],
          bindingIds: [],
          roleIds: [],
          restrictionIds: [],
        },
      };
    },
  };
}

test("OCC rejects Namespace lifecycle Role Permissions before any IAM Driver or State write", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  const { controller: occ } = await bootstrap(controller);
  const namespace = await createNamespace(controller, "occ-role-permission-check");
  const driverCalls: IAMManagedRoleInput[] = [];
  // This Driver admits every request and accepts every Role without validation or State
  // writes, so only OCC's own Permission check can reject a Namespace lifecycle action.
  const permissiveDriver: IAMDriver = {
    ...createPermissiveIAMDriver(fixture, {
      id: "iam-permissive-role-sink",
      implementation: "occ-permission-isolation-test",
      reason: "admitted for OCC Permission isolation test",
    }),
    namespacePolicyTransaction: "platform-unit-of-work",
    async createNamespaceRole(_context, role) {
      driverCalls.push(role);
      return role;
    },
  };
  occ.registerDriver(permissiveDriver);
  occ.selectDriver("iam", permissiveDriver.id);
  const createRole = (permissions: readonly Permission[]) =>
    controller.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
      body: { permissions },
    });

  for (const action of [
    "create",
    "update",
    "delete",
    "deploy",
    "operate",
    "administer",
    "read_logs",
  ] as const) {
    const rejected = await createRole([{ action, resourceKind: "namespace" }]);
    assertApiError(rejected, 400, "INVALID_REQUEST");
  }
  // A create Permission on a child kind is refused by OCC too, whatever the Driver accepts.
  const childCreate = await createRole([
    { action: "read", resourceKind: "agent" },
    { action: "create", resourceKind: "agent" },
  ]);
  const { error: childCreateError } = assertApiError(childCreate, 400, "INVALID_REQUEST");
  assert.deepEqual(childCreateError.details, [
    { path: "/permissions/1/action", code: "INVALID_VALUE" },
  ]);
  assert.equal(driverCalls.length, 0, "OCC must reject before delegating to the IAM Driver");

  // Control: the same Driver receives a Namespace read Role, so the rejection above is OCC's.
  const reader = await createRole([{ action: "read", resourceKind: "namespace" }]);
  assert.equal(reader.status, 201, JSON.stringify(reader.body));
  assert.deepEqual(
    driverCalls.map((role) => role.permissions),
    [[{ action: "read", resourceKind: "namespace" }]],
  );
});

test("Console share grants confer only the shared Agent and Namespace discovery", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  const member = await fixture.createAuthPrincipal("share-recipient");
  fixture.state.identities.push(member.principal);
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "share-recipient-limits");
  const agent = await createAgent(controller, namespace.id, "shared-agent");
  const sibling = await createAgent(controller, namespace.id, "sibling-agent");
  const policyPath = `/namespaces/${namespace.id}/iam`;
  // The exact grants the Console share panel writes.
  for (const [resourceKind, resourceId, permissions] of [
    ["namespace", namespace.id, [{ action: "read", resourceKind: "namespace" }]],
    [
      "agent",
      agent.id,
      [
        { action: "read", resourceKind: "agent" },
        { action: "administer", resourceKind: "agent" },
      ],
    ],
  ] as const) {
    const role = await controller.request("POST", `${policyPath}/roles`, {
      body: { permissions },
    });
    const { data: roleData } = checkedBody(role, 201, IAMRoleResponse);
    const binding = await controller.request("POST", `${policyPath}/access-bindings`, {
      body: {
        subjectKind: "identity",
        subjectId: member.principal.id,
        roleId: roleData.id,
        resourceKind,
        resourceId,
      },
    });
    const { data: bindingData } = checkedBody(binding, 201, IAMAccessBindingResponse);
    // Mirror persisted policy into the native IAM state, as production loadNativeIAMState does.
    // The live Postgres proof is in postgres-namespace-iam-policy.test.ts.
    fixture.state.roles.push(roleData);
    fixture.state.bindings.push(bindingData);
  }

  const memberApp = fixture.createApp(member.principal);
  const asMember: FixtureRequest = (method, path, options) =>
    injectedRequest(memberApp, method, path, options);
  for (const path of [
    `/namespaces/${namespace.id}`,
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  ]) {
    const allowed = await asMember("GET", path);
    assert.equal(allowed.status, 200, `${path}: ${JSON.stringify(allowed.body)}`);
  }
  const latestRole = fixture.state.roles.at(-1);
  assert(latestRole);
  for (const [method, path, body] of [
    ["DELETE", `/namespaces/${namespace.id}`],
    ["GET", `/namespaces/${namespace.id}/agents/${sibling.id}`],
    ["GET", `${policyPath}/roles`],
    ["POST", `${policyPath}/roles`, { permissions: [{ action: "read", resourceKind: "agent" }] }],
    ["GET", `${policyPath}/access-bindings`],
    [
      "POST",
      `${policyPath}/access-bindings`,
      {
        subjectKind: "identity",
        subjectId: member.principal.id,
        roleId: latestRole.id,
        resourceKind: "agent",
        resourceId: sibling.id,
      },
    ],
    ["DELETE", `/namespaces/${namespace.id}/agents/${agent.id}`],
    ["GET", "/installation"],
  ] as const) {
    const denied = await asMember(method, path, body === undefined ? {} : { body });
    assert.equal(denied.status, 403, `${method} ${path}: ${JSON.stringify(denied.body)}`);
  }
  const after = await controller.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  const { data: afterData } = checkedBody(after, 200, AgentReadResponse);
  assert.equal(afterData.status, agent.status, "the shared Agent must not enter deletion");
  const bindings = await controller.request("GET", `${policyPath}/access-bindings`);
  const { data: bindingsData } = checkedBody(bindings, 200, IAMAccessBindingListResponse);
  assert.equal(bindingsData.length, 2, "denied policy writes must leave policy unchanged");
});

test("Namespace IAM read routes serialize broad native policy without widening mutations", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  const { controller: occ } = await bootstrap(controller);
  const namespace = await createNamespace(controller, "iam-native-read-policy");
  const role: Role = {
    id: "role_native_read_policy",
    namespaceId: namespace.id,
    name: "Native namespace reader",
    permissions: [
      { action: "read", resourceKind: "namespace" },
      { action: "read", resourceKind: "agent_revision" },
    ],
  };
  const binding: AccessBinding = {
    id: "binding_native_group_namespace",
    namespaceId: namespace.id,
    subjectKind: "group",
    subjectId: "grp_native_namespace_operators",
    roleId: role.id,
  };
  const readPolicyDriver: IAMDriver = {
    ...createPermissiveIAMDriver(fixture, {
      id: "iam-native-read-policy",
      implementation: "native-read-policy-test",
      reason: "admitted for native read policy serialization",
    }),
    async listNamespaceRoles(_context, namespaceId) {
      return namespaceId === namespace.id ? [role] : [];
    },
    async getNamespaceRole(_context, namespaceId, roleId) {
      return namespaceId === namespace.id && roleId === role.id ? role : undefined;
    },
    async listNamespaceAccessBindings(_context, namespaceId) {
      return namespaceId === namespace.id ? [binding] : [];
    },
    async getNamespaceAccessBinding(_context, namespaceId, bindingId) {
      return namespaceId === namespace.id && bindingId === binding.id ? binding : undefined;
    },
  };
  occ.registerDriver(readPolicyDriver);
  occ.selectDriver("iam", readPolicyDriver.id);

  const roles = await controller.request("GET", `/namespaces/${namespace.id}/iam/roles`);
  const { data: rolesData } = checkedBody(roles, 200, IAMRoleListResponse);
  assert.deepEqual(rolesData, [role]);

  const roleDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/roles/${role.id}`,
  );
  const { data: roleDetailData } = checkedBody(roleDetail, 200, IAMRoleResponse);
  assert.deepEqual(roleDetailData, role);

  const bindings = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/access-bindings`,
  );
  const { data: bindingsData } = checkedBody(bindings, 200, IAMAccessBindingListResponse);
  assert.deepEqual(bindingsData, [binding]);

  const bindingDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/access-bindings/${binding.id}`,
  );
  const { data: bindingDetailData } = checkedBody(bindingDetail, 200, IAMAccessBindingResponse);
  assert.deepEqual(bindingDetailData, binding);

  const broadRoleCreate = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/iam/roles`,
    {
      body: {
        name: "Rejected broad mutating role",
        permissions: [{ action: "read", resourceKind: "installation" }],
      },
    },
  );
  assertApiError(broadRoleCreate, 400, "INVALID_REQUEST");

  const groupBindingCreate = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/iam/access-bindings`,
    {
      body: {
        subjectKind: "group",
        subjectId: binding.subjectId,
        roleId: role.id,
        resourceKind: "secret",
        resourceId: "sec_11111111-1111-4111-8111-111111111111",
      },
    },
  );
  assertApiError(groupBindingCreate, 400, "INVALID_REQUEST");

  const broadBindingCreate = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/iam/access-bindings`,
    {
      body: {
        subjectKind: "identity",
        subjectId: fixture.principal.id,
        roleId: role.id,
      },
    },
  );
  assertApiError(broadBindingCreate, 400, "INVALID_REQUEST");
});

test("Namespace IAM routes fail closed without policy management and roll back audit failures", async (t) => {
  const unsupported = await configuredController();
  const { fixture: unsupportedFixture } = unsupported;
  const { controller: unsupportedOcc, platformState: unsupportedState } =
    await bootstrap(unsupported);
  const unsupportedNamespace = await createNamespace(unsupported, "unsupported-iam");
  const unsupportedDriver = createPermissiveIAMDriver(unsupportedFixture, {
    id: "iam-without-policy-management",
    implementation: "admission-only-test",
    reason: "admitted for unsupported management test",
  });
  unsupportedOcc.registerDriver(unsupportedDriver);
  unsupportedOcc.selectDriver("iam", unsupportedDriver.id);
  const dependencyFailure = await unsupported.request(
    "POST",
    `/namespaces/${unsupportedNamespace.id}/iam/roles`,
    {
      body: {
        name: "Unsupported",
        permissions: [{ action: "operate", resourceKind: "secret" }],
      },
    },
  );
  assertApiError(dependencyFailure, 503, "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(
    await unsupportedState.read((unit) => unit.iamPolicy.listRoles(unsupportedNamespace.id)),
    [],
  );

  // A Driver must declare transaction participation before any policy write.
  // Keep the real native implementation; omit only its optional capability declaration.
  const transactional = await configuredController();
  const { fixture: transactionFixture } = transactional;
  const { controller: transactionalOcc, platformState: transactionalState } =
    await bootstrap(transactional);
  const transactionNamespace = await createNamespace(transactional, "undeclared-iam-transaction");
  const policyPath = `/namespaces/${transactionNamespace.id}/iam`;
  const namespaceRole = await transactional.request("POST", `${policyPath}/roles`, {
    body: { permissions: [{ action: "read", resourceKind: "namespace" }] },
  });
  const { data: namespaceRoleData } = checkedBody(namespaceRole, 201, IAMRoleResponse);
  const unusedRole = await transactional.request("POST", `${policyPath}/roles`, {
    body: { permissions: [{ action: "read", resourceKind: "agent" }] },
  });
  const { data: unusedRoleData } = checkedBody(unusedRole, 201, IAMRoleResponse);
  const binding = {
    subjectKind: "identity",
    subjectId: transactionFixture.principal.id,
    roleId: namespaceRoleData.id,
    resourceKind: "namespace",
    resourceId: transactionNamespace.id,
  };
  const existingBinding = await transactional.request("POST", `${policyPath}/access-bindings`, {
    body: binding,
  });
  const { data: existingBindingData } = checkedBody(existingBinding, 201, IAMAccessBindingResponse);
  const policy = () =>
    transactionalState.read(async (unit) => ({
      roles: await unit.iamPolicy.listRoles(transactionNamespace.id),
      bindings: await unit.iamPolicy.listAccessBindings(transactionNamespace.id),
      principals: await unit.iamPolicy.listServicePrincipals(transactionNamespace.id),
    }));
  const before = await policy();
  const undeclared = new NativeIAMDriver(
    { loadNativeIAMState: async () => transactionFixture.state },
    { id: "iam-without-declared-transaction" },
  );
  assert(Reflect.deleteProperty(undeclared, "namespacePolicyTransaction"));
  transactionalOcc.registerDriver(undeclared);
  transactionalOcc.selectDriver("iam", undeclared.id);
  assert.equal((await transactional.request("GET", `${policyPath}/roles`)).status, 200);
  const refusedStatuses: number[] = [];
  for (const [method, path, body] of [
    ["POST", `${policyPath}/roles`, { permissions: [{ action: "read", resourceKind: "agent" }] }],
    ["DELETE", `${policyPath}/roles/${unusedRoleData.id}`],
    ["POST", `${policyPath}/access-bindings`, binding],
    ["DELETE", `${policyPath}/access-bindings/${existingBindingData.id}`],
    ["POST", `${policyPath}/service-principals`, {}],
  ] as const) {
    const refused = await transactional.request(method, path, body === undefined ? {} : { body });
    const { meta } = assertApiError(refused, 503, "DEPENDENCY_UNAVAILABLE", `${method} ${path}`);
    refusedStatuses.push(refused.status);
    assert.deepEqual(await policy(), before);
    assert.equal(refused.headers.get("x-request-id"), meta.requestId);
    assert.equal(
      transactional.auditSink.events.some(
        (event) => event.requestId === meta.requestId && event.kind === "mutation",
      ),
      false,
    );
  }
  t.diagnostic(
    JSON.stringify({
      scenario: "transaction-capability-refusal",
      statuses: refusedStatuses,
      policyPreserved: true,
      successAudit: 0,
    }),
  );

  const rollback = await configuredController();
  const { platformState: rollbackState } = await bootstrap(rollback);
  const rollbackNamespace = await createNamespace(rollback, "rollback-iam");
  const originalAppend = rollback.auditSink.append.bind(rollback.auditSink);
  rollback.auditSink.append = async (event) => {
    if (
      event.action === "openclaw.iam.roles.create" ||
      event.action === "openclaw.iam.service_principals.create"
    ) {
      throw new Error("synthetic audit outage");
    }
    await originalAppend(event);
  };

  const auditFailure = await rollback.request(
    "POST",
    `/namespaces/${rollbackNamespace.id}/iam/roles`,
    {
      body: {
        name: "Rolled back",
        permissions: [{ action: "operate", resourceKind: "secret" }],
      },
    },
  );
  assertApiError(auditFailure, 503, "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(
    await rollbackState.read((unit) => unit.iamPolicy.listRoles(rollbackNamespace.id)),
    [],
  );
  // A ServicePrincipal whose create cannot be audited is rolled back.
  const principalAuditFailure = await rollback.request(
    "POST",
    `/namespaces/${rollbackNamespace.id}/iam/service-principals`,
    { body: {} },
  );
  assertApiError(principalAuditFailure, 503, "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(
    await rollbackState.read((unit) => unit.iamPolicy.listServicePrincipals(rollbackNamespace.id)),
    [],
  );
});
