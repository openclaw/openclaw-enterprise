import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import type {
  IAMManagedAccessBindingInput,
  Permission,
} from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { databaseUrl, testPool } from "../helpers/postgres-database.mjs";
import {
  auditEvent,
  createHumanPrincipal,
  createNamespaceAgentState,
  createNamespaceServicePrincipal,
  identifier,
} from "./postgres-namespace-iam-fixture.ts";

export async function atomicBindingAudit(context: TestContext) {
  const pool: Pool = testPool(context, { connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  const iam = new NativeIAMDriver(state, { id: "postgres-namespace-iam" });
  const { installation, namespace, secret, agent } = await createNamespaceAgentState(state);
  const { secretRole, firstBinding, secondBinding } = await state.transact(async (unit) => {
    const secretRole = await iam.createNamespaceRole(
      { policy: unit.iamPolicy },
      {
        id: identifier("role"),
        namespaceId: namespace.id,
        name: "Agent Secret operator",
        permissions: [{ action: "operate", resourceKind: "secret" }],
      },
    );
    const createBinding = () =>
      iam.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        {
          id: identifier("binding"),
          namespaceId: namespace.id,
          subjectKind: "identity",
          subjectId: agent.servicePrincipalId,
          roleId: secretRole.id,
          resourceKind: "secret",
          resourceId: secret.id,
        },
      );
    const firstBinding = await createBinding();
    const secondBinding = await createBinding();
    await unit.audit.append(
      auditEvent(
        installation.id,
        namespace.id,
        "principal-postgres-namespace-iam",
        "openclaw.iam.accessBindings.create",
        { kind: "secret", id: secret.id, namespaceId: namespace.id },
      ),
    );
    return { secretRole, firstBinding, secondBinding };
  });

  assert.equal(secretRole.namespaceId, namespace.id);
  assert.notEqual(firstBinding.id, secondBinding.id);
  const savedRole = await state.read((unit) =>
    iam.getNamespaceRole({ policy: unit.iamPolicy }, namespace.id, secretRole.id),
  );
  assert.deepEqual(savedRole?.permissions, [{ action: "operate", resourceKind: "secret" }]);

  const replicaPool: Pool = testPool(context, { connectionString: databaseUrl });
  const replicaState = new PostgresPlatformState(replicaPool);
  const replicaIAM = new NativeIAMDriver(replicaState, {
    id: "postgres-namespace-iam-replica",
  });
  const replicaRole = await replicaState.read((unit) =>
    replicaIAM.getNamespaceRole({ policy: unit.iamPolicy }, namespace.id, secretRole.id),
  );
  assert.equal(replicaRole?.id, secretRole.id);

  const granted = await iam.authorize({
    principalId: agent.servicePrincipalId,
    action: "operate",
    resource: { kind: "secret", id: secret.id, namespaceId: namespace.id },
  });
  assert.equal(granted.allowed, true);
  assert.deepEqual(
    [...granted.evidence.bindingIds].sort(),
    [firstBinding.id, secondBinding.id].sort(),
  );

  const replicaGranted = await replicaIAM.authorize({
    principalId: agent.servicePrincipalId,
    action: "operate",
    resource: { kind: "secret", id: secret.id, namespaceId: namespace.id },
  });
  assert.equal(replicaGranted.allowed, true);

  await assert.rejects(
    state.transact((unit) =>
      iam.deleteNamespaceRole({ policy: unit.iamPolicy }, namespace.id, secretRole.id),
    ),
    { name: "IAMRoleInUseError" },
  );
  await state.transact(async (unit) => {
    assert.equal(
      await iam.deleteNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        namespace.id,
        firstBinding.id,
      ),
      true,
    );
  });

  const afterOneDelete = await iam.authorize({
    principalId: agent.servicePrincipalId,
    action: "operate",
    resource: { kind: "secret", id: secret.id, namespaceId: namespace.id },
  });
  assert.equal(afterOneDelete.allowed, true);
  assert.deepEqual(afterOneDelete.evidence.bindingIds, [secondBinding.id]);

  await state.transact(async (unit) => {
    assert.equal(
      await iam.deleteNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        namespace.id,
        secondBinding.id,
      ),
      true,
    );
    assert.equal(
      await iam.deleteNamespaceRole({ policy: unit.iamPolicy }, namespace.id, secretRole.id),
      true,
    );
  });
  const denied = await iam.authorize({
    principalId: agent.servicePrincipalId,
    action: "operate",
    resource: { kind: "secret", id: secret.id, namespaceId: namespace.id },
  });
  assert.equal(denied.allowed, false);
  assert.equal(
    await state.transact((unit) => unit.secrets.deleteSecret(namespace.id, secret.id)),
    true,
  );

  const audit = await state.transact((unit) => unit.audit.list());
  assert.ok(
    audit.some(
      (event) =>
        event.action === "openclaw.iam.accessBindings.create" &&
        event.resource.id === secret.id &&
        event.namespaceId === namespace.id,
    ),
  );
}

export async function agentServicePrincipalOwnership(context: TestContext) {
  const pool: Pool = testPool(context, { connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  const iam = new NativeIAMDriver(state, { id: "postgres-namespace-iam-agent-subject" });
  const { namespace, secret, agent } = await createNamespaceAgentState(state);
  const localService = await createNamespaceServicePrincipal(state, namespace.id);
  const role = await state.transact((unit) =>
    iam.createNamespaceRole(
      { policy: unit.iamPolicy },
      {
        id: identifier("role"),
        namespaceId: namespace.id,
        permissions: [{ action: "operate", resourceKind: "secret" }],
      },
    ),
  );
  const bindingInput = (subjectId: string): IAMManagedAccessBindingInput => ({
    id: identifier("binding"),
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId,
    roleId: role.id,
    resourceKind: "secret",
    resourceId: secret.id,
  });

  // The live Agent's ServicePrincipal and a non-Agent local service remain bindable.
  await state.transact(async (unit) => {
    for (const subjectId of [agent.servicePrincipalId, localService]) {
      await iam.createNamespaceAccessBinding({ policy: unit.iamPolicy }, bindingInput(subjectId));
    }
  });

  // The Agent owner key is deferred, so a unit can hold an Agent-owned ServicePrincipal
  // without a live Agent. State must reject it as the in-memory adapter does, rather than
  // accept it and leave the commit to fail. Observe the rejection inside the unit,
  // because the deferred key failure at commit is also reported as a ScopeViolation.
  const orphan = `service-agent-${randomUUID()}`;
  await assert.rejects(
    state.transact(async (unit) => {
      await state.queryInTransaction(
        unit,
        `INSERT INTO occ.iam_identities (id, kind, namespace_id, agent_id)
         VALUES ($1, 'service_principal', $2, $3)`,
        [orphan, namespace.id, identifier("agt")],
      );
      await assert.rejects(
        iam.createNamespaceAccessBinding({ policy: unit.iamPolicy }, bindingInput(orphan)),
        { name: "IAMPolicyValidationError" },
        "State must reject the orphan subject before COMMIT",
      );
      throw new Error("roll back the deferred orphan fixture");
    }),
    /roll back the deferred orphan fixture/,
  );
  assert.equal(
    (await state.read((unit) => unit.iamPolicy.listAccessBindings(namespace.id))).filter(
      (binding) => binding.subjectId === orphan,
    ).length,
    0,
  );
}

export async function auditRollback(context: TestContext) {
  const pool: Pool = testPool(context, { connectionString: databaseUrl });
  const observer: Pool = testPool(context, { connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  const iam = new NativeIAMDriver(state, { id: "postgres-namespace-iam-rollback" });
  const { installation, namespace, secret } = await createNamespaceAgentState(state);
  const roleId = identifier("role");
  const servicePrincipalId = identifier("spn");
  let servicePrincipalAuditAppended = false;

  await assert.rejects(
    state.transact(async (unit) => {
      await iam.createNamespaceRole(
        { policy: unit.iamPolicy },
        {
          id: roleId,
          namespaceId: namespace.id,
          permissions: [{ action: "operate", resourceKind: "secret" }],
        },
      );
      await iam.createNamespaceServicePrincipal(
        { policy: unit.iamPolicy },
        { id: servicePrincipalId, namespaceId: namespace.id },
      );
      // The valid create event must be rolled back with its identity when the later
      // invalid-scope audit rejects the transaction.
      await unit.audit.append({
        ...auditEvent(
          installation.id,
          namespace.id,
          "principal-postgres-namespace-iam",
          "openclaw.iam.service_principals.create",
          { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
        ),
        details: { servicePrincipalId },
      });
      servicePrincipalAuditAppended = true;
      await unit.audit.append(
        auditEvent(
          installation.id,
          namespace.id,
          "principal-postgres-namespace-iam",
          "openclaw.iam.roles.create",
          { kind: "secret", id: secret.id, namespaceId: identifier("ns") },
        ),
      );
    }),
    { name: "ScopeViolationError" },
  );
  assert.equal(servicePrincipalAuditAppended, true);

  const rolledBack = await state.read((unit) =>
    iam.getNamespaceRole({ policy: unit.iamPolicy }, namespace.id, roleId),
  );
  assert.equal(rolledBack, undefined);
  // Observe committed rows through a separate pool, outside the rejected unit.
  assert.deepEqual(
    (await observer.query("SELECT id FROM occ.iam_identities WHERE id = $1", [servicePrincipalId]))
      .rows,
    [],
  );
  assert.deepEqual(
    (
      await observer.query(
        "SELECT id FROM occ.iam_access_bindings WHERE identity_subject_id = $1",
        [servicePrincipalId],
      )
    ).rows,
    [],
  );
  assert.deepEqual(
    (
      await observer.query(
        `SELECT id FROM occ.audit_events
         WHERE action = 'openclaw.iam.service_principals.create' AND outcome = 'success'
           AND details->>'servicePrincipalId' = $1`,
        [servicePrincipalId],
      )
    ).rows,
    [],
  );
}

export async function namespaceRolePermissions(context: TestContext) {
  const pool: Pool = testPool(context, { connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  const iam = new NativeIAMDriver(state);
  const { installation, namespace } = await createNamespaceAgentState(state);
  const principal = await createHumanPrincipal(state, installation.id);
  const permissions: Permission[] = [
    { action: "read", resourceKind: "namespace" },
    { action: "delete", resourceKind: "namespace" },
  ];
  const roleId = identifier("role");
  await assert.rejects(
    state.transact((unit) =>
      iam.createNamespaceRole(
        { policy: unit.iamPolicy },
        { id: roleId, namespaceId: namespace.id, permissions },
      ),
    ),
    /managed Namespace Role permissions support only read/,
  );
  // The State writer refuses the Role even when a caller bypasses the IAM Driver.
  await assert.rejects(
    state.transact((unit) =>
      unit.iamPolicy.createRole({ id: roleId, namespaceId: namespace.id, permissions }),
    ),
    { name: "ScopeViolationError", message: /support only Namespace read/ },
  );
  assert.equal(
    await state.transact((unit) => unit.iamPolicy.getRole(namespace.id, roleId)),
    undefined,
  );

  // A Role row written before this restriction cannot be bound to the Namespace.
  await state.transact((unit) =>
    state.queryInTransaction(
      unit,
      "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, $2, NULL, $3::jsonb)",
      [roleId, namespace.id, JSON.stringify(permissions)],
    ),
  );
  await assert.rejects(
    state.transact((unit) =>
      iam.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        {
          id: identifier("binding"),
          namespaceId: namespace.id,
          subjectKind: "identity",
          subjectId: principal.id,
          roleId,
          resourceKind: "namespace",
          resourceId: namespace.id,
        },
      ),
    ),
    { name: "IAMPolicyValidationError", message: /support only Namespace read/ },
  );
  assert.deepEqual(
    await state.transact((unit) => unit.iamPolicy.listAccessBindings(namespace.id)),
    [],
  );
}

export async function namespaceLocalServiceIdentity(context: TestContext) {
  const pool: Pool = testPool(context, { connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  const iam = new NativeIAMDriver(state, { id: "postgres-namespace-iam-service-identity" });
  const { namespace, secret } = await createNamespaceAgentState(state);
  const identityId = await createNamespaceServicePrincipal(state, namespace.id);
  const binding = await state.transact(async (unit) => {
    const role = await iam.createNamespaceRole(
      { policy: unit.iamPolicy },
      {
        id: identifier("role"),
        namespaceId: namespace.id,
        permissions: [{ action: "operate", resourceKind: "secret" }],
      },
    );
    const binding = await iam.createNamespaceAccessBinding(
      { policy: unit.iamPolicy },
      {
        id: identifier("binding"),
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: identityId,
        roleId: role.id,
        resourceKind: "secret",
        resourceId: secret.id,
      },
    );
    return binding;
  });

  const granted = await iam.authorize({
    principalId: identityId,
    action: "operate",
    resource: { kind: "secret", id: secret.id, namespaceId: namespace.id },
  });
  assert.equal(granted.allowed, true);
  assert.deepEqual(granted.evidence.bindingIds, [binding.id]);
}

export async function exactRevisionBinding(context: TestContext) {
  const pool: Pool = testPool(context, { connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  const iam = new NativeIAMDriver(state, { id: "postgres-namespace-iam-agent-revision" });
  const { namespace, configuration, agent } = await createNamespaceAgentState(state, {
    harnessAuth: { method: "runtime" },
  });
  const revision = await state.transact((unit) =>
    unit.revisions.createRevision({
      id: identifier("rev"),
      namespaceId: namespace.id,
      agentId: agent.id,
      revision: 1,
      backendId: null,
      configurationId: configuration.id,
      configurationKind: "agent",
      configurationGeneration: configuration.generation,
      gatewayManagedMode: agent.gatewayManagedMode,
      configuration: {},
      harness: {
        id: "test-harness",
        version: "1.0.0",
        mode: "embedded",
        overrides: {},
        configuration: {},
      },
      compute: { id: "test-compute", implementation: "test" },
      executionAdmission: { version: 2, mode: "unprotected" },
      harnessAuth: { method: "runtime" },
      servicePrincipalId: agent.servicePrincipalId,
      createdAt: new Date().toISOString(),
    }),
  );
  const binding = await state.transact(async (unit) => {
    const role = await iam.createNamespaceRole(
      { policy: unit.iamPolicy },
      {
        id: identifier("role"),
        namespaceId: namespace.id,
        permissions: [{ action: "read", resourceKind: "agent_revision" }],
      },
    );
    const binding = await iam.createNamespaceAccessBinding(
      { policy: unit.iamPolicy },
      {
        id: identifier("binding"),
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: role.id,
        resourceKind: "agent_revision",
        resourceId: revision.id,
      },
    );
    return binding;
  });

  const granted = await iam.authorize({
    principalId: agent.servicePrincipalId,
    action: "read",
    resource: { kind: "agent_revision", id: revision.id, namespaceId: namespace.id },
  });
  assert.equal(granted.allowed, true);
  assert.deepEqual(granted.evidence.bindingIds, [binding.id]);
}

export async function invalidBindings(context: TestContext) {
  const pool: Pool = testPool(context, { connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  const iam = new NativeIAMDriver(state, { id: "postgres-namespace-iam-rejects" });
  const { namespace, secret, agent } = await createNamespaceAgentState(state);
  const foreign = await createNamespaceAgentState(state);
  const role = await state.transact(async (unit) => {
    const role = await iam.createNamespaceRole(
      { policy: unit.iamPolicy },
      {
        id: identifier("role"),
        namespaceId: namespace.id,
        permissions: [{ action: "read", resourceKind: "agent" }],
      },
    );
    return role;
  });

  await assert.rejects(
    state.transact((unit) =>
      iam.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        {
          id: identifier("binding"),
          namespaceId: namespace.id,
          subjectKind: "identity",
          subjectId: foreign.agent.servicePrincipalId,
          roleId: role.id,
          resourceKind: "secret",
          resourceId: secret.id,
        },
      ),
    ),
    { name: "IAMPolicyValidationError" },
  );
  await assert.rejects(
    state.transact((unit) =>
      iam.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        {
          id: identifier("binding"),
          namespaceId: namespace.id,
          // @ts-expect-error JavaScript callers can submit a group to the managed binding API.
          subjectKind: "group",
          subjectId: agent.servicePrincipalId,
          roleId: role.id,
          resourceKind: "secret",
          resourceId: secret.id,
        },
      ),
    ),
    /identity subjects/,
  );
  await assert.rejects(
    state.transact((unit) =>
      iam.createNamespaceRole(
        { policy: unit.iamPolicy },
        {
          id: identifier("role"),
          namespaceId: namespace.id,
          permissions: [{ action: "administer", resourceKind: "installation" }],
        },
      ),
    ),
    /resource kind/,
  );
  await assert.rejects(
    state.transact((unit) =>
      iam.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        {
          id: identifier("binding"),
          namespaceId: namespace.id,
          subjectKind: "identity",
          subjectId: agent.servicePrincipalId,
          roleId: role.id,
          resourceKind: "secret",
          resourceId: identifier("sec"),
        },
      ),
    ),
    { name: "IAMPolicyValidationError" },
  );
}
