import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createBootstrapAdministratorSeed, NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};

function identifier(kind) {
  return `${kind}_${randomUUID()}`;
}

function auditEvent(installationId, namespaceId, actorId, action, resource) {
  return {
    id: identifier("aud"),
    installationId,
    namespaceId,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    actorId,
    source: "occ",
    action,
    resource,
    outcome: "success",
  };
}

async function createNamespaceAgentState(state, options = {}) {
  const createdAt = new Date().toISOString();
  const installation = (await state.loadInstallation()) ?? {
    id: identifier("ins"),
    name: `Namespace IAM ${randomUUID()}`,
    createdAt,
  };
  const namespace = {
    id: identifier("ns"),
    name: `namespace-iam-${randomUUID()}`,
    status: "ready",
    createdAt,
  };
  const secret = {
    id: identifier("sec"),
    namespaceId: namespace.id,
    name: `Model secret ${randomUUID()}`,
    driverId: "secret-postgres-namespace-iam",
    backendRef: {
      namespaceName: "namespace-iam",
      name: "model-secret",
      key: "value",
      uid: randomUUID(),
    },
    createdAt,
  };
  const configuration = {
    id: identifier("cfg"),
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt,
  };
  const agent = {
    id: identifier("agt"),
    namespaceId: namespace.id,
    name: `Agent ${randomUUID()}`,
    configurationId: configuration.id,
    backendId: null,
    harnessAuth: options.harnessAuth ?? null,
    executionMode: "embedded",
    servicePrincipalId: `service-agent-${randomUUID()}`,
    desiredRuntimeState: "stopped",
    createdAt,
  };

  await state.transact(async (unit) => {
    if ((await unit.installations.getInstallation()) === undefined) {
      await unit.installations.createInstallation(installation);
    }
    await unit.namespaces.createNamespace(namespace);
    await unit.secrets.createSecret(secret);
    await unit.configurations.createConfiguration(configuration);
    await unit.agents.createAgent(agent);
  });
  try {
    await state.loadNativeIAMState(installation.id);
  } catch {
    const seed = createBootstrapAdministratorSeed(installation.id, "https://identity.example.com", {
      id: `postgres-namespace-iam-${randomUUID()}`,
    });
    await state.seedNativeIAM({
      identities: [seed.principal, seed.servicePrincipal],
      groups: [],
      memberships: [],
      roles: seed.roles,
      bindings: seed.bindings,
      restrictions: [],
    });
  }

  return { installation, namespace, secret, configuration, agent };
}

async function createNamespaceServicePrincipal(state, namespaceId) {
  const identityId = `service-principal-${randomUUID()}`;
  await state.transact(async (unit) => {
    // Seed an existing Namespace-local service identity that is not owned by an Agent.
    await state.queryInTransaction(
      unit,
      `INSERT INTO occ.iam_identities (id, kind, namespace_id, agent_id)
       VALUES ($1, 'service_principal', $2, NULL)`,
      [identityId, namespaceId],
    );
  });
  return identityId;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function isLockTimeout(error) {
  return error?.code === "55P03" || /lock timeout/.test(error?.message ?? "");
}

test(
  "PostgreSQL native IAM creates exact Namespace bindings atomically with audit",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const iam = new NativeIAMDriver(state, { id: "postgres-namespace-iam" });
    const { installation, namespace, secret, agent } = await createNamespaceAgentState(state);
    let secretRole;
    let firstBinding;
    let secondBinding;

    await state.transact(async (unit) => {
      secretRole = await iam.createNamespaceRole(
        { policy: unit.iamPolicy },
        {
          id: identifier("role"),
          namespaceId: namespace.id,
          name: "Agent Secret operator",
          permissions: [{ action: "operate", resourceKind: "secret" }],
        },
      );
      firstBinding = await iam.createNamespaceAccessBinding(
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
      secondBinding = await iam.createNamespaceAccessBinding(
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
      await unit.audit.append(
        auditEvent(
          installation.id,
          namespace.id,
          "principal-postgres-namespace-iam",
          "openclaw.iam.accessBindings.create",
          { kind: "secret", id: secret.id, namespaceId: namespace.id },
        ),
      );
    });

    assert.equal(secretRole.namespaceId, namespace.id);
    assert.notEqual(firstBinding.id, secondBinding.id);
    const savedRole = await state.read((unit) =>
      iam.getNamespaceRole({ policy: unit.iamPolicy }, namespace.id, secretRole.id),
    );
    assert.deepEqual(savedRole?.permissions, [{ action: "operate", resourceKind: "secret" }]);

    const replicaPool = new Pool({ connectionString: databaseUrl });
    context.after(() => replicaPool.end());
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
      { name: "ResourceConflictError" },
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
  },
);

test(
  "PostgreSQL native IAM serializes AccessBinding creation before target deletion",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const createPool = new Pool({ connectionString: databaseUrl });
    const deletePool = new Pool({ connectionString: databaseUrl });
    context.after(() => createPool.end());
    context.after(() => deletePool.end());
    const createState = new PostgresPlatformState(createPool);
    const deleteState = new PostgresPlatformState(deletePool);
    const iam = new NativeIAMDriver(createState, { id: "postgres-namespace-iam-create-race" });
    const { namespace, secret, agent } = await createNamespaceAgentState(createState);
    let role;
    let binding;

    await createState.transact(async (unit) => {
      role = await iam.createNamespaceRole(
        { policy: unit.iamPolicy },
        {
          id: identifier("role"),
          namespaceId: namespace.id,
          permissions: [{ action: "operate", resourceKind: "secret" }],
        },
      );
    });

    const bindingCreated = deferred();
    const releaseCreate = deferred();
    const create = createState.transact(async (unit) => {
      binding = await iam.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        {
          id: identifier("binding"),
          namespaceId: namespace.id,
          subjectKind: "identity",
          subjectId: agent.servicePrincipalId,
          roleId: role.id,
          resourceKind: "secret",
          resourceId: secret.id,
        },
      );
      bindingCreated.resolve();
      await releaseCreate.promise;
    });

    await bindingCreated.promise;
    try {
      await assert.rejects(
        deleteState.transact(async (unit) => {
          await deleteState.queryInTransaction(unit, "SET LOCAL lock_timeout = '50ms'");
          await unit.secrets.deleteSecret(namespace.id, secret.id);
        }),
        isLockTimeout,
      );
    } finally {
      releaseCreate.resolve();
    }
    await create;

    assert.equal(binding.resourceId, secret.id);
    assert.equal(
      await deleteState.transact((unit) => unit.secrets.deleteSecret(namespace.id, secret.id)),
      true,
    );
  },
);

test(
  "PostgreSQL native IAM serializes target deletion before AccessBinding creation",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const deletePool = new Pool({ connectionString: databaseUrl });
    const createPool = new Pool({ connectionString: databaseUrl });
    context.after(() => deletePool.end());
    context.after(() => createPool.end());
    const deleteState = new PostgresPlatformState(deletePool);
    const createState = new PostgresPlatformState(createPool);
    const iam = new NativeIAMDriver(createState, { id: "postgres-namespace-iam-delete-race" });
    const { namespace, secret, agent } = await createNamespaceAgentState(deleteState);
    let role;

    await createState.transact(async (unit) => {
      role = await iam.createNamespaceRole(
        { policy: unit.iamPolicy },
        {
          id: identifier("role"),
          namespaceId: namespace.id,
          permissions: [{ action: "operate", resourceKind: "secret" }],
        },
      );
    });

    const targetDeleted = deferred();
    const releaseDelete = deferred();
    const deletion = deleteState.transact(async (unit) => {
      assert.equal(await unit.secrets.deleteSecret(namespace.id, secret.id), true);
      targetDeleted.resolve();
      await releaseDelete.promise;
    });

    await targetDeleted.promise;
    try {
      await assert.rejects(
        createState.transact(async (unit) => {
          await createState.queryInTransaction(unit, "SET LOCAL lock_timeout = '50ms'");
          await iam.createNamespaceAccessBinding(
            { policy: unit.iamPolicy },
            {
              id: identifier("binding"),
              namespaceId: namespace.id,
              subjectKind: "identity",
              subjectId: agent.servicePrincipalId,
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
    }
    await deletion;

    await assert.rejects(
      createState.transact((unit) =>
        iam.createNamespaceAccessBinding(
          { policy: unit.iamPolicy },
          {
            id: identifier("binding"),
            namespaceId: namespace.id,
            subjectKind: "identity",
            subjectId: agent.servicePrincipalId,
            roleId: role.id,
            resourceKind: "secret",
            resourceId: secret.id,
          },
        ),
      ),
      { name: "ScopeViolationError" },
    );
  },
);

test(
  "PostgreSQL native IAM rolls back policy mutations when transaction audit fails",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const iam = new NativeIAMDriver(state, { id: "postgres-namespace-iam-rollback" });
    const { installation, namespace, secret } = await createNamespaceAgentState(state);
    const roleId = identifier("role");

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

    const rolledBack = await state.read((unit) =>
      iam.getNamespaceRole({ policy: unit.iamPolicy }, namespace.id, roleId),
    );
    assert.equal(rolledBack, undefined);
  },
);

test(
  "PostgreSQL native IAM authorizes Namespace-local service identities without Agent ownership",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const iam = new NativeIAMDriver(state, { id: "postgres-namespace-iam-service-identity" });
    const { namespace, secret } = await createNamespaceAgentState(state);
    const identityId = await createNamespaceServicePrincipal(state, namespace.id);
    let role;
    let binding;

    await state.transact(async (unit) => {
      role = await iam.createNamespaceRole(
        { policy: unit.iamPolicy },
        {
          id: identifier("role"),
          namespaceId: namespace.id,
          permissions: [{ action: "operate", resourceKind: "secret" }],
        },
      );
      binding = await iam.createNamespaceAccessBinding(
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
    });

    const granted = await iam.authorize({
      principalId: identityId,
      action: "operate",
      resource: { kind: "secret", id: secret.id, namespaceId: namespace.id },
    });
    assert.equal(granted.allowed, true);
    assert.deepEqual(granted.evidence.bindingIds, [binding.id]);
  },
);

test(
  "PostgreSQL native IAM creates exact AgentRevision bindings with limited app privileges",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
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
        configuration: {},
        harness: { id: "test-harness", version: "1.0.0", mode: "embedded" },
        compute: { id: "test-compute", implementation: "test" },
        harnessAuth: { method: "runtime" },
        servicePrincipalId: agent.servicePrincipalId,
        createdAt: new Date().toISOString(),
      }),
    );
    let role;
    let binding;

    await state.transact(async (unit) => {
      role = await iam.createNamespaceRole(
        { policy: unit.iamPolicy },
        {
          id: identifier("role"),
          namespaceId: namespace.id,
          permissions: [{ action: "read", resourceKind: "agent_revision" }],
        },
      );
      binding = await iam.createNamespaceAccessBinding(
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
    });

    const granted = await iam.authorize({
      principalId: agent.servicePrincipalId,
      action: "read",
      resource: { kind: "agent_revision", id: revision.id, namespaceId: namespace.id },
    });
    assert.equal(granted.allowed, true);
    assert.deepEqual(granted.evidence.bindingIds, [binding.id]);
  },
);

test(
  "PostgreSQL native IAM rejects foreign subjects, broad grants, and absent targets",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const iam = new NativeIAMDriver(state, { id: "postgres-namespace-iam-rejects" });
    const { namespace, secret, agent } = await createNamespaceAgentState(state);
    const foreign = await createNamespaceAgentState(state);
    let role;

    await state.transact(async (unit) => {
      role = await iam.createNamespaceRole(
        { policy: unit.iamPolicy },
        {
          id: identifier("role"),
          namespaceId: namespace.id,
          permissions: [{ action: "read", resourceKind: "agent" }],
        },
      );
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
      { name: "ScopeViolationError" },
    );
    await assert.rejects(
      state.transact((unit) =>
        iam.createNamespaceAccessBinding(
          { policy: unit.iamPolicy },
          {
            id: identifier("binding"),
            namespaceId: namespace.id,
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
            permissions: [{ action: "administer", resourceKind: "namespace" }],
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
      { name: "ScopeViolationError" },
    );
  },
);
