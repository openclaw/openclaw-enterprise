import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import type {
  AccessBinding,
  IAMManagedAccessBindingInput,
} from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { deferred } from "../helpers/deferred.ts";
import { databaseUrl, testPool } from "../helpers/postgres-database.mjs";
import { BINDING_SUBJECT_INELIGIBLE } from "../helpers/refusal-text.mjs";
import {
  createHumanPrincipal,
  createNamespaceAgentState,
  identifier,
  isLockTimeout,
} from "./postgres-namespace-iam-fixture.ts";

export async function grantBeforeTargetDeletion(context: TestContext) {
  const createPool: Pool = testPool(context, { connectionString: databaseUrl });
  const deletePool: Pool = testPool(context, { connectionString: databaseUrl });
  const createState = new PostgresPlatformState(createPool);
  const deleteState = new PostgresPlatformState(deletePool);
  const iam = new NativeIAMDriver(createState, { id: "postgres-namespace-iam-create-race" });
  const { installation, namespace, secret, agent } = await createNamespaceAgentState(createState);
  const principal = await createHumanPrincipal(createState, installation.id);
  const role = await createState.transact((unit) =>
    iam.createNamespaceRole(
      { policy: unit.iamPolicy },
      {
        id: identifier("role"),
        namespaceId: namespace.id,
        permissions: [{ action: "operate", resourceKind: "secret" }],
      },
    ),
  );

  // Hold the uncommitted binding while a second connection tries to delete its target.
  const bindingCreated = deferred();
  const releaseCreate = deferred();
  const create = createState.transact(async (unit) => {
    const binding = await iam.createNamespaceAccessBinding(
      { policy: unit.iamPolicy },
      {
        id: identifier("binding"),
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: role.id,
        resourceKind: "secret",
        resourceId: secret.id,
      },
    );
    bindingCreated.resolve();
    await releaseCreate.promise;
    return binding;
  });

  let binding: Readonly<AccessBinding>;
  try {
    await Promise.race([bindingCreated.promise, create]);
    await assert.rejects(
      deleteState.transact(async (unit) => {
        await deleteState.queryInTransaction(unit, "SET LOCAL lock_timeout = '50ms'");
        await unit.secrets.deleteSecret(namespace.id, secret.id);
      }),
      isLockTimeout,
    );
  } finally {
    releaseCreate.resolve();
    binding = await create;
  }

  assert.equal(binding.resourceId, secret.id);
  // Existence is not enough for asynchronous Agent teardown: status changes
  // do not modify a key, so the grant must also conflict with ordinary UPDATE.
  const agentRole = await createState.transact((unit) =>
    iam.createNamespaceRole(
      { policy: unit.iamPolicy },
      {
        id: identifier("role"),
        namespaceId: namespace.id,
        permissions: [{ action: "read", resourceKind: "agent" }],
      },
    ),
  );
  const agentBinding: IAMManagedAccessBindingInput = {
    id: identifier("binding"),
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: agentRole.id,
    resourceKind: "agent",
    resourceId: agent.id,
  };
  await createState.transact(async (unit) => {
    await iam.createNamespaceAccessBinding({ policy: unit.iamPolicy }, agentBinding);
    await assert.rejects(
      deleteState.transact(async (other) => {
        await deleteState.queryInTransaction(other, "SET LOCAL lock_timeout = '50ms'");
        await other.agents.transitionAgentStatus(namespace.id, agent.id, "active", "deleting");
      }),
      isLockTimeout,
    );
  });
  const deletingAgent = await deleteState.transact((unit) =>
    unit.agents.transitionAgentStatus(namespace.id, agent.id, "active", "deleting"),
  );
  assert.equal(deletingAgent?.status, "deleting");
  await assert.rejects(
    createState.transact((unit) =>
      iam.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        { ...agentBinding, id: identifier("binding"), subjectId: principal.id },
      ),
    ),
    /target does not exist in this Namespace or is being deleted/,
  );
  // Deletion also removes bindings for the Agent's ServicePrincipal, so a deleting
  // Agent's ServicePrincipal is no longer a bindable subject for any target.
  await assert.rejects(
    createState.transact((unit) =>
      iam.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        {
          ...agentBinding,
          id: identifier("binding"),
          resourceKind: "secret",
          resourceId: secret.id,
        },
      ),
    ),
    { message: BINDING_SUBJECT_INELIGIBLE },
  );

  assert.equal(
    await deleteState.transact((unit) => unit.secrets.deleteSecret(namespace.id, secret.id)),
    true,
  );
}

export async function targetDeletionBeforeGrant(context: TestContext) {
  const deletePool: Pool = testPool(context, { connectionString: databaseUrl });
  const createPool: Pool = testPool(context, { connectionString: databaseUrl });
  const deleteState = new PostgresPlatformState(deletePool);
  const createState = new PostgresPlatformState(createPool);
  const iam = new NativeIAMDriver(createState, { id: "postgres-namespace-iam-delete-race" });
  const { installation, namespace, secret } = await createNamespaceAgentState(deleteState);
  const principal = await createHumanPrincipal(deleteState, installation.id);
  const role = await createState.transact((unit) =>
    iam.createNamespaceRole(
      { policy: unit.iamPolicy },
      {
        id: identifier("role"),
        namespaceId: namespace.id,
        permissions: [{ action: "operate", resourceKind: "secret" }],
      },
    ),
  );

  // Reverse the lock order and observe the grant both before and after deletion commits.
  const targetDeleted = deferred();
  const releaseDelete = deferred();
  const deletion = deleteState.transact(async (unit) => {
    assert.equal(await unit.secrets.deleteSecret(namespace.id, secret.id), true);
    targetDeleted.resolve();
    await releaseDelete.promise;
  });

  try {
    await Promise.race([targetDeleted.promise, deletion]);
    await assert.rejects(
      createState.transact(async (unit) => {
        await createState.queryInTransaction(unit, "SET LOCAL lock_timeout = '50ms'");
        await iam.createNamespaceAccessBinding(
          { policy: unit.iamPolicy },
          {
            id: identifier("binding"),
            namespaceId: namespace.id,
            subjectKind: "identity",
            subjectId: principal.id,
            roleId: role.id,
            resourceKind: "secret",
            resourceId: secret.id,
          },
        );
      }),
      isLockTimeout,
    );
  } finally {
    releaseDelete.resolve();
    await deletion;
  }

  await assert.rejects(
    createState.transact((unit) =>
      iam.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        {
          id: identifier("binding"),
          namespaceId: namespace.id,
          subjectKind: "identity",
          subjectId: principal.id,
          roleId: role.id,
          resourceKind: "secret",
          resourceId: secret.id,
        },
      ),
    ),
    { name: "IAMPolicyValidationError" },
  );
}

export async function grantBeforeNamespaceDeletion(context: TestContext) {
  const grantPool: Pool = testPool(context, { connectionString: databaseUrl });
  const deletePool: Pool = testPool(context, { connectionString: databaseUrl });
  const state = new PostgresPlatformState(grantPool);
  const deletionState = new PostgresPlatformState(deletePool);
  const iam = new NativeIAMDriver(state);
  const { installation } = await createNamespaceAgentState(state);
  const principal = await createHumanPrincipal(state, installation.id);
  // An empty, ready Namespace can enter deletion through its ordinary lifecycle.
  const namespace = await state.transact((unit) =>
    unit.namespaces.createNamespace({
      id: identifier("ns"),
      name: `grant-deletion-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    }),
  );
  const role = await state.transact((unit) =>
    iam.createNamespaceRole(
      { policy: unit.iamPolicy },
      {
        id: identifier("role"),
        namespaceId: namespace.id,
        permissions: [{ action: "read", resourceKind: "namespace" }],
      },
    ),
  );
  const input: IAMManagedAccessBindingInput = {
    id: identifier("binding"),
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: principal.id,
    roleId: role.id,
    resourceKind: "namespace",
    resourceId: namespace.id,
  };
  const granted = deferred();
  const releaseGrant = deferred();
  const grant = state.transact(async (unit) => {
    await iam.createNamespaceAccessBinding({ policy: unit.iamPolicy }, input);
    granted.resolve();
    await releaseGrant.promise;
  });
  try {
    await Promise.race([granted.promise, grant]);
    await assert.rejects(
      deletionState.transact(async (unit) => {
        await deletionState.queryInTransaction(unit, "SET LOCAL lock_timeout = '50ms'");
        await unit.namespaces.transitionNamespaceStatus(namespace.id, "ready", "deleting");
      }),
      isLockTimeout,
    );
  } finally {
    releaseGrant.resolve();
    await grant;
  }
  await deletionState.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "ready", "deleting"),
  );
  await assert.rejects(
    state.transact((unit) =>
      iam.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        { ...input, id: identifier("binding") },
      ),
    ),
    { name: "ScopeViolationError" },
  );
}
