import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import type {
  AuthorizationRequest,
  IAMManagedAccessBindingInput,
  Permission,
} from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  OpenClawController,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { databaseUrl, testPool } from "../helpers/postgres-database.mjs";
import {
  auditEvent,
  createHumanPrincipal,
  createNamespaceAgentState,
  identifier,
} from "./postgres-namespace-iam-fixture.ts";

export async function grantAndRevokeHumanAccess(context: TestContext) {
  const pool: Pool = testPool(context, { connectionString: databaseUrl });
  const replicaPool: Pool = testPool(context, { connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  const iam = new NativeIAMDriver(state);
  const replica = new NativeIAMDriver(new PostgresPlatformState(replicaPool));
  const { installation, namespace, agent } = await createNamespaceAgentState(state);
  const foreign = await createNamespaceAgentState(state);
  const principal = await createHumanPrincipal(state, installation.id);
  const request = (
    resourceKind: AuthorizationRequest["resource"]["kind"],
    resourceId: string,
    namespaceId = namespace.id,
  ): AuthorizationRequest => ({
    principalId: principal.id,
    action: "read",
    resource: { kind: resourceKind, id: resourceId, namespaceId },
  });
  assert.equal((await replica.authorize(request("namespace", namespace.id))).allowed, false);
  const role = await state.transact((unit) =>
    iam.createNamespaceRole(
      { policy: unit.iamPolicy },
      {
        id: identifier("role"),
        namespaceId: namespace.id,
        permissions: [
          { action: "read", resourceKind: "namespace" },
          { action: "read", resourceKind: "agent" },
        ],
      },
    ),
  );
  const bindingInput = (
    resourceKind: IAMManagedAccessBindingInput["resourceKind"],
    resourceId: string,
  ): IAMManagedAccessBindingInput => ({
    id: identifier("binding"),
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: principal.id,
    roleId: role.id,
    resourceKind,
    resourceId,
  });
  const namespaceBinding = bindingInput("namespace", namespace.id);
  const agentBinding = bindingInput("agent", agent.id);

  // Rejection of the audit append must also roll back the human grant.
  await assert.rejects(
    state.transact(async (unit) => {
      await iam.createNamespaceAccessBinding({ policy: unit.iamPolicy }, namespaceBinding);
      await unit.audit.append(
        auditEvent(
          installation.id,
          namespace.id,
          principal.id,
          "openclaw.iam.accessBindings.create",
          { kind: "namespace", id: namespace.id, namespaceId: foreign.namespace.id },
        ),
      );
    }),
    { name: "ScopeViolationError" },
  );
  assert.equal((await replica.authorize(request("namespace", namespace.id))).allowed, false);

  await state.transact(async (unit) => {
    for (const binding of [namespaceBinding, agentBinding]) {
      await iam.createNamespaceAccessBinding({ policy: unit.iamPolicy }, binding);
      await unit.audit.append(
        auditEvent(
          installation.id,
          namespace.id,
          principal.id,
          "openclaw.iam.accessBindings.create",
          { kind: binding.resourceKind, id: binding.resourceId, namespaceId: namespace.id },
        ),
      );
    }
  });
  for (const binding of [namespaceBinding, agentBinding]) {
    const decision = await replica.authorize(request(binding.resourceKind, binding.resourceId));
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.evidence.bindingIds, [binding.id]);
  }
  for (const denied of [
    request("namespace", foreign.namespace.id, foreign.namespace.id),
    request("agent", foreign.agent.id, foreign.namespace.id),
    request("agent", identifier("agt")),
    { ...request("agent", agent.id), action: "administer" } satisfies AuthorizationRequest,
  ]) {
    assert.equal((await replica.authorize(denied)).allowed, false);
  }
  for (const input of [
    bindingInput("namespace", foreign.namespace.id),
    bindingInput("namespace", identifier("ns")),
    bindingInput("agent", namespace.id),
    { ...bindingInput("namespace", namespace.id), subjectId: identifier("principal") },
    { ...bindingInput("namespace", namespace.id), subjectId: foreign.agent.servicePrincipalId },
  ]) {
    await assert.rejects(
      state.transact((unit) => iam.createNamespaceAccessBinding({ policy: unit.iamPolicy }, input)),
      { name: "IAMPolicyValidationError" },
    );
  }

  await state.transact(async (unit) => {
    await iam.deleteNamespaceAccessBinding(
      { policy: unit.iamPolicy },
      namespace.id,
      agentBinding.id,
    );
    await unit.audit.append(
      auditEvent(
        installation.id,
        namespace.id,
        principal.id,
        "openclaw.iam.accessBindings.delete",
        { kind: "agent", id: agent.id, namespaceId: namespace.id },
      ),
    );
  });
  assert.equal((await replica.authorize(request("agent", agent.id))).allowed, false);
  assert.equal((await replica.authorize(request("namespace", namespace.id))).allowed, true);
  const audit = await state.transact((unit) => unit.audit.list());
  assert.equal(
    audit.filter(
      (event) =>
        event.actorId === principal.id && event.action === "openclaw.iam.accessBindings.create",
    ).length,
    2,
  );
}

export async function consoleShareScope(context: TestContext) {
  const pool: Pool = testPool(context, { connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  const iam = new NativeIAMDriver(state, { id: `postgres-share-limits-${randomUUID()}` });
  const { installation, namespace, agent } = await createNamespaceAgentState(state);
  const sibling = {
    ...agent,
    id: identifier("agt"),
    name: `Sibling ${randomUUID()}`,
    servicePrincipalId: `service-agent-${randomUUID()}`,
  };
  await state.transact((unit) => unit.agents.createAgent(sibling));
  const principal = await createHumanPrincipal(state, installation.id);
  // Persist exactly the grants the Console share panel writes.
  const { namespaceBinding, agentBinding } = await state.transact(async (unit) => {
    async function grant(
      resourceKind: IAMManagedAccessBindingInput["resourceKind"],
      resourceId: string,
      permissions: readonly Permission[],
    ) {
      const role = await iam.createNamespaceRole(
        { policy: unit.iamPolicy },
        { id: identifier("role"), namespaceId: namespace.id, permissions },
      );
      return iam.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        {
          id: identifier("binding"),
          namespaceId: namespace.id,
          subjectKind: "identity",
          subjectId: principal.id,
          roleId: role.id,
          resourceKind,
          resourceId,
        },
      );
    }

    const namespaceBinding = await grant("namespace", namespace.id, [
      { action: "read", resourceKind: "namespace" },
    ]);
    const agentBinding = await grant("agent", agent.id, [
      { action: "read", resourceKind: "agent" },
      { action: "administer", resourceKind: "agent" },
    ]);
    return { namespaceBinding, agentBinding };
  });
  // OCC authorizes every route below against the live PostgreSQL policy.
  const controller = new OpenClawController(installation, { state, recordOperations: false });
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);

  assert.equal((await controller.getNamespace(principal.id, namespace.id)).id, namespace.id);
  assert.equal((await controller.getAgent(principal.id, namespace.id, agent.id)).id, agent.id);
  const denied = {
    "DELETE /namespaces/:id": () => controller.deleteNamespace(principal.id, namespace.id),
    "GET sibling Agent": () => controller.getAgent(principal.id, namespace.id, sibling.id),
    "GET IAM Roles": () => controller.listIAMRoles(principal.id, namespace.id),
    "POST IAM Roles": () =>
      controller.createIAMRole(principal.id, {
        namespaceId: namespace.id,
        permissions: [{ action: "read", resourceKind: "agent" }],
      }),
    "GET IAM AccessBindings": () => controller.listIAMAccessBindings(principal.id, namespace.id),
    "POST IAM AccessBindings": () =>
      controller.createIAMAccessBinding(principal.id, {
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: agentBinding.roleId,
        resourceKind: "agent",
        resourceId: sibling.id,
      }),
    "DELETE shared Agent": () => controller.deleteAgent(principal.id, namespace.id, agent.id),
    "GET /installation": () => controller.getInstallation(principal.id),
  };
  for (const [route, operation] of Object.entries(denied)) {
    // OCC maps AuthorizationDeniedError to 403.
    await assert.rejects(operation, AuthorizationDeniedError, route);
  }

  const after = await state.transact(async (unit) => ({
    namespace: await unit.namespaces.findNamespace(namespace.id),
    agent: await unit.agents.findAgent(namespace.id, agent.id),
    bindings: await iam.listNamespaceAccessBindings({ policy: unit.iamPolicy }, namespace.id),
  }));
  assert.ok(after.namespace);
  assert.ok(after.agent);
  assert.equal(after.namespace.status, namespace.status);
  assert.notEqual(after.agent.status, "deleting");
  assert.equal(after.agent.desiredRuntimeState, agent.desiredRuntimeState);
  assert.deepEqual(
    after.bindings.map((binding) => binding.id).sort(),
    [namespaceBinding.id, agentBinding.id].sort(),
  );
}
