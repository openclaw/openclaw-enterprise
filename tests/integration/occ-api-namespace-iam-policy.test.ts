import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  IAMAccessBindingListResponse,
  IAMAccessBindingResponse,
  IAMRoleListResponse,
  IAMRoleResponse,
  SecretResponse,
  type AuthorizationRequest,
  type CreateIAMAccessBindingBody,
  type Permission,
  type ResourceRef,
} from "../../packages/contracts/src/index.ts";
import {
  createConfiguration,
  createNamespace,
  createReadyNamespace,
  identifier,
  injectedRequest,
  readyNamespaceFixture,
} from "./occ-api-injected-fixture.ts";
import { registerNamespaceIAMPolicyCases } from "./occ-api-namespace-iam-policy-cases.ts";
import {
  assertApiError,
  bootstrap,
  checkedBody,
  configuredController,
  createAgent,
} from "./occ-api-namespace-iam-policy-fixture.ts";

type BindingKind = CreateIAMAccessBindingBody["resourceKind"];

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

registerNamespaceIAMPolicyCases();
