import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AgentReadResponse,
  IAMAccessBindingListResponse,
  IAMAccessBindingResponse,
  IAMRoleListResponse,
  IAMRoleResponse,
  NamespaceResponse,
  type AccessBinding,
  type CreateIAMAccessBindingBody,
  type IAMDriver,
  type IAMManagedRoleInput,
  type Permission,
  type Role,
} from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { BINDING_SUBJECT_EMAIL, BINDING_SUBJECT_INELIGIBLE } from "../helpers/refusal-text.mjs";
import {
  createNamespace,
  injectedRequest,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";
import {
  assertApiError,
  bootstrap,
  checkedBody,
  configuredController,
  createAgent,
  type TestController,
} from "./occ-api-namespace-iam-policy-fixture.ts";

type Fixture = TestController["fixture"];

async function assertRoleValidation(controller: TestController, namespaceId: string) {
  const createRole = (permissions: readonly Permission[]) =>
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
    const rejected = await createRole([
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
    kinds.flatMap((resourceKind) => actions.map((action) => ({ action, resourceKind }))),
  );
  const { error: manyError } = assertApiError(many, 400, "INVALID_REQUEST");
  assert.deepEqual(manyError.details, [{ path: "/permissions", code: "INVALID_VALUE" }]);
  assert.ok(Array.from(manyError.message).length <= 256, manyError.message);
  assert.match(
    manyError.message,
    /^No operation checks these Permissions, so they would grant nothing: agent_revision:administer, .* and \d+ more\. See the per-kind actions in the permissions reference\.$/,
  );
  const duplicate = await createRole([
    { action: "read", resourceKind: "agent" },
    { action: "read", resourceKind: "agent" },
  ]);
  const { error: duplicateError } = assertApiError(duplicate, 400, "INVALID_REQUEST");
  assert.deepEqual(duplicateError.details, [{ path: "/permissions/1", code: "INVALID_VALUE" }]);
  assert.match(duplicateError.message, /agent:read more than once/);
  const lifecycle = await createRole([{ action: "delete", resourceKind: "namespace" }]);
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
      const rejected = await createRole(permissions);
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
  const allCreates = await createRole([
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
  const roles = await controller.request("GET", `/namespaces/${namespaceId}/iam/roles`);
  const { data: rolesData } = checkedBody(roles, 200, IAMRoleListResponse);
  assert.deepEqual(rolesData, [], "rejected Roles must not be persisted");

  // Every supported pair is still accepted.
  const supported = await createRole([
    { action: "read", resourceKind: "namespace" },
    { action: "operate", resourceKind: "secret" },
    { action: "read_logs", resourceKind: "agent" },
    { action: "administer", resourceKind: "agent" },
    { action: "read", resourceKind: "agent_revision" },
    { action: "operate", resourceKind: "credential_source" },
  ]);
  assert.equal(supported.status, 201, JSON.stringify(supported.body));
}

async function assertAccessBindingConflicts(
  controller: TestController,
  { namespaceId, otherId, memberId }: { namespaceId: string; otherId: string; memberId: string },
) {
  const createReader = async (id: string) => {
    const role = await controller.request("POST", `/namespaces/${id}/iam/roles`, {
      body: { permissions: [{ action: "read", resourceKind: "namespace" }] },
    });
    const { data } = checkedBody(role, 201, IAMRoleResponse);
    return data.id;
  };
  const readerId = await createReader(namespaceId);
  const foreignRoleId = await createReader(otherId);

  const bindingPath = `/namespaces/${namespaceId}/iam/access-bindings`;
  const bind = (body: Partial<CreateIAMAccessBindingBody>) =>
    controller.request("POST", bindingPath, {
      body: {
        subjectKind: "identity",
        subjectId: memberId,
        roleId: readerId,
        resourceKind: "namespace",
        resourceId: namespaceId,
        ...body,
      },
    });
  for (const [body, path] of [
    [{ resourceId: otherId }, "/resourceId"],
    [{ roleId: foreignRoleId }, "/roleId"],
    [{ roleId: `role_${randomUUID()}` }, "/roleId"],
  ] as const) {
    const rejected = await bind(body);
    const { error: rejectedError } = assertApiError(rejected, 400, "INVALID_REQUEST", path);
    assert.deepEqual(rejectedError.details, [{ path, code: "INVALID_VALUE" }]);
  }
  // The email diagnostic identifies a caller-supplied mistake. Unknown IDs get the generic
  // ineligible-principal response.
  const email = await bind({ subjectId: "nora@example.com" });
  const { error: emailError } = assertApiError(email, 400, "INVALID_REQUEST", "/subjectId");
  assert.deepEqual(emailError.details, [{ path: "/subjectId", code: "INVALID_VALUE" }]);
  assert.equal(emailError.message, BINDING_SUBJECT_EMAIL);
  const unknown = await bind({ subjectId: `prn_${randomUUID()}` });
  const { error: unknownError } = assertApiError(unknown, 400, "INVALID_REQUEST");
  assert.deepEqual(unknownError.details, [{ path: "/subjectId", code: "INVALID_VALUE" }]);
  assert.equal(unknownError.message, BINDING_SUBJECT_INELIGIBLE);

  const listBindings = async () => {
    const listed = await controller.request("GET", bindingPath);
    return checkedBody(listed, 200, IAMAccessBindingListResponse).data;
  };
  assert.deepEqual(await listBindings(), [], "rejected AccessBindings must not be persisted");

  const { data: binding } = checkedBody(await bind({}), 201, IAMAccessBindingResponse);
  assert.deepEqual(await listBindings(), [binding]);

  // Deleting a referenced Role reports why the Role is still in use.
  const inUse = await controller.request(
    "DELETE",
    `/namespaces/${namespaceId}/iam/roles/${readerId}`,
  );
  const { error: inUseError } = assertApiError(inUse, 409, "RESOURCE_CONFLICT");
  assert.match(inUseError.message, /referenced by AccessBindings/);
}

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

export function registerNamespaceIAMPolicyCases() {
  test("Namespace IAM reports invalid policy input as 400 with the field and refuses inert Permissions", async () => {
    const controller = await configuredController();
    const { fixture } = controller;
    const member = await fixture.createAuthPrincipal("policy-validation-member");
    fixture.state.identities.push(member.principal);
    await bootstrap(controller);
    const namespace = await createNamespace(controller, "policy-validation");
    const other = await createNamespace(controller, "policy-validation-other");
    await assertRoleValidation(controller, namespace.id);
    await assertAccessBindingConflicts(controller, {
      namespaceId: namespace.id,
      otherId: other.id,
      memberId: member.principal.id,
    });
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
    const { data: existingBindingData } = checkedBody(
      existingBinding,
      201,
      IAMAccessBindingResponse,
    );
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
      await rollbackState.read((unit) =>
        unit.iamPolicy.listServicePrincipals(rollbackNamespace.id),
      ),
      [],
    );
  });
}
