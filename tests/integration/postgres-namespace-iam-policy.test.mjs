import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createAuthPrincipalSeed,
  createBootstrapAdministratorSeed,
  NativeIAMDriver,
} from "../../packages/iam/src/index.ts";
import { AuthorizationDeniedError, OpenClawController } from "../../packages/occ/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

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

async function createHumanPrincipal(state) {
  // Enroll through the zero-grant auth account seed: a real Installation-scoped
  // Principal with no Namespace service identity, Role, or binding. The
  // Installation ID is unused because no-grant seeds create no bindings.
  const seed = createAuthPrincipalSeed(
    "installation-unused-by-zero-grant-seed",
    "https://identity.example.com",
    { id: randomUUID() },
    { grant: "none" },
  );
  assert.deepEqual(seed.roles, []);
  assert.deepEqual(seed.bindings, []);
  await state.appendNativeIAMPrincipal(seed);
  return seed.principal;
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
  "selected native IAM sees original-unit grants and revocations before rollback",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    // One connection also catches an accidental nested policy read: it cannot
    // acquire a second client while the original transaction owns the first.
    const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1000 });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const iam = new NativeIAMDriver(state);
    const { namespace, secret, agent } = await createNamespaceAgentState(state);
    const request = {
      principalId: agent.servicePrincipalId,
      action: "operate",
      resource: { kind: "secret", id: secret.id, namespaceId: namespace.id },
    };
    assert.equal((await iam.authorize(request)).allowed, false);
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
        const binding = await iam.createNamespaceAccessBinding(
          { policy: unit.iamPolicy },
          {
            id: identifier("binding"),
            namespaceId: namespace.id,
            subjectKind: "identity",
            subjectId: agent.servicePrincipalId,
            roleId,
            resourceKind: "secret",
            resourceId: secret.id,
          },
        );
        const granted = await iam.authorize(request);
        assert.equal(granted.allowed, true);
        assert.deepEqual(granted.evidence.bindingIds, [binding.id]);
        assert.equal(
          await iam.deleteNamespaceAccessBinding(
            { policy: unit.iamPolicy },
            namespace.id,
            binding.id,
          ),
          true,
        );
        assert.equal((await iam.authorize(request)).allowed, false);
        throw new Error("abort original policy operation");
      }),
      /abort original policy operation/,
    );
    assert.equal((await iam.authorize(request)).allowed, false);
    assert.equal(
      await state.read((unit) => unit.iamPolicy.getRole(namespace.id, roleId)),
      undefined,
    );
  },
);

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
  },
);

test(
  "PostgreSQL native IAM binds Agent ServicePrincipals only while their Agent owns them",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
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
    const bindingInput = (subjectId) => ({
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
    let bindingError;
    await assert.rejects(
      state.transact(async (unit) => {
        await state.queryInTransaction(
          unit,
          `INSERT INTO occ.iam_identities (id, kind, namespace_id, agent_id)
           VALUES ($1, 'service_principal', $2, $3)`,
          [orphan, namespace.id, identifier("agt")],
        );
        try {
          await iam.createNamespaceAccessBinding({ policy: unit.iamPolicy }, bindingInput(orphan));
        } catch (error) {
          bindingError = error;
          throw error;
        }
      }),
      { name: "IAMPolicyValidationError" },
    );
    assert.equal(
      bindingError?.name,
      "IAMPolicyValidationError",
      "State must reject the orphan subject",
    );
    assert.equal(
      (await state.read((unit) => unit.iamPolicy.listAccessBindings(namespace.id))).filter(
        (binding) => binding.subjectId === orphan,
      ).length,
      0,
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
    const principal = await createHumanPrincipal(createState);
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
          subjectId: principal.id,
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
    const agentBinding = {
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
    assert.equal(
      (
        await deleteState.transact((unit) =>
          unit.agents.transitionAgentStatus(namespace.id, agent.id, "active", "deleting"),
        )
      ).status,
      "deleting",
    );
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
      /the ServicePrincipal of a live Agent here/,
    );

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
    const { namespace, secret } = await createNamespaceAgentState(deleteState);
    const principal = await createHumanPrincipal(deleteState);
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
            subjectId: principal.id,
            roleId: role.id,
            resourceKind: "secret",
            resourceId: secret.id,
          },
        ),
      ),
      { name: "IAMPolicyValidationError" },
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
  "PostgreSQL native IAM grants and revokes existing human access to exact Namespace and Agent targets",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    const replicaPool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    context.after(() => replicaPool.end());
    const state = new PostgresPlatformState(pool);
    const iam = new NativeIAMDriver(state);
    const replica = new NativeIAMDriver(new PostgresPlatformState(replicaPool));
    const { installation, namespace, agent } = await createNamespaceAgentState(state);
    const foreign = await createNamespaceAgentState(state);
    const principal = await createHumanPrincipal(state);
    const request = (resourceKind, resourceId, namespaceId = namespace.id) => ({
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
    const bindingInput = (resourceKind, resourceId) => ({
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
    for (const [kind, id, binding] of [
      ["namespace", namespace.id, namespaceBinding],
      ["agent", agent.id, agentBinding],
    ]) {
      const decision = await replica.authorize(request(kind, id));
      assert.equal(decision.allowed, true);
      assert.deepEqual(decision.evidence.bindingIds, [binding.id]);
    }
    for (const denied of [
      request("namespace", foreign.namespace.id, foreign.namespace.id),
      request("agent", foreign.agent.id, foreign.namespace.id),
      request("agent", identifier("agt")),
      { ...request("agent", agent.id), action: "administer" },
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
        state.transact((unit) =>
          iam.createNamespaceAccessBinding({ policy: unit.iamPolicy }, input),
        ),
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
  },
);

test(
  "PostgreSQL native IAM confines Console share grants to the shared Agent and Namespace discovery",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
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
    const principal = await createHumanPrincipal(state);
    // Persist exactly the grants the Console share panel writes.
    const bindings = await state.transact(async (unit) => {
      const created = [];
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
      ]) {
        const role = await iam.createNamespaceRole(
          { policy: unit.iamPolicy },
          { id: identifier("role"), namespaceId: namespace.id, permissions },
        );
        created.push(
          await iam.createNamespaceAccessBinding(
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
          ),
        );
      }
      return created;
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
          roleId: bindings[1].roleId,
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
    assert.equal(after.namespace.status, namespace.status);
    assert.notEqual(after.agent.status, "deleting");
    assert.equal(after.agent.desiredRuntimeState, agent.desiredRuntimeState);
    assert.deepEqual(
      after.bindings.map((binding) => binding.id).sort(),
      bindings.map((binding) => binding.id).sort(),
    );
  },
);

test(
  "PostgreSQL native IAM grants Namespace Roles only Namespace read",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const iam = new NativeIAMDriver(state);
    const { namespace } = await createNamespaceAgentState(state);
    const principal = await createHumanPrincipal(state);
    const permissions = [
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
  },
);

test(
  "PostgreSQL exact Namespace grants serialize with Namespace deletion",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const grantPool = new Pool({ connectionString: databaseUrl });
    const deletePool = new Pool({ connectionString: databaseUrl });
    context.after(() => grantPool.end());
    context.after(() => deletePool.end());
    const state = new PostgresPlatformState(grantPool);
    const deletionState = new PostgresPlatformState(deletePool);
    const iam = new NativeIAMDriver(state);
    await createNamespaceAgentState(state);
    const principal = await createHumanPrincipal(state);
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
    const input = {
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
    await Promise.race([granted.promise, grant]);
    try {
      await assert.rejects(
        deletionState.transact(async (unit) => {
          await deletionState.queryInTransaction(unit, "SET LOCAL lock_timeout = '50ms'");
          await unit.namespaces.transitionNamespaceStatus(namespace.id, "ready", "deleting");
        }),
        isLockTimeout,
      );
    } finally {
      releaseGrant.resolve();
    }
    await grant;
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
      { name: "IAMPolicyValidationError" },
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
  },
);

test(
  "PostgreSQL IAM policy writes keep the actor's authority current through COMMIT",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const iam = new NativeIAMDriver(state, { id: `postgres-iam-commit-fence-${randomUUID()}` });
    const { installation, namespace, agent } = await createNamespaceAgentState(state);
    const issuer = "https://identity.example.com";

    // Installation-scoped Roles for the actors. The administrator reads Namespaces
    // through the Installation; the delegate needs a Namespace-scoped read binding.
    const roles = { admin: identifier("role"), delegate: identifier("role") };
    await pool.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, NULL, 'Fence admin', $2::jsonb), ($3, NULL, 'Fence delegate', $4::jsonb)`,
      [
        roles.admin,
        JSON.stringify([
          { action: "administer", resourceKind: "installation" },
          { action: "read", resourceKind: "namespace" },
          { action: "read", resourceKind: "agent" },
        ]),
        roles.delegate,
        JSON.stringify([{ action: "administer", resourceKind: "installation" }]),
      ],
    );
    async function humanActor(roleId) {
      const userId = randomUUID();
      const seed = createAuthPrincipalSeed(installation.id, issuer, { id: userId }, { roleId });
      await state.appendNativeIAMPrincipal(seed);
      await pool.query(
        `INSERT INTO occ."user" (id, name, email, created_at, updated_at)
         VALUES ($1, 'Fence actor', $2, clock_timestamp(), clock_timestamp())`,
        [userId, `fence-${userId}@example.test`],
      );
      await pool.query(
        `INSERT INTO occ.human_authentication_accounts (user_id, installation_id, principal_id)
         VALUES ($1, $2, $3)`,
        [userId, installation.id, seed.principal.id],
      );
      return { userId, principalId: seed.principal.id };
    }
    const admin = await humanActor(roles.admin);
    // Account seeds scope their binding to the Installation resource; the administrator
    // also holds the Role across the Installation, like the bootstrap administrator.
    await pool.query(
      `INSERT INTO occ.iam_access_bindings (id, identity_subject_id, role_id) VALUES ($1, $2, $3)`,
      [identifier("binding"), admin.principalId, roles.admin],
    );
    const delegate = await humanActor(roles.delegate);

    // Runs `race` once, right after the admission decision for `trigger` is made.
    let pending;
    const controller = new OpenClawController(installation, {
      state,
      recordOperations: false,
      authorize: async (request) => {
        const decision = await iam.authorize(request);
        const race = pending;
        if (race !== undefined && race.matches(request)) {
          pending = undefined;
          await race.run();
        }
        return decision;
      },
    });
    controller.registerDriver(iam);
    controller.selectDriver("iam", iam.id);
    const namespaceRead = (principalId) => (request) =>
      request.principalId === principalId &&
      request.action === "read" &&
      request.resource.kind === "namespace";

    const readRole = await controller.createIAMRole(admin.principalId, {
      namespaceId: namespace.id,
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    const delegateRead = await controller.createIAMAccessBinding(admin.principalId, {
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: delegate.principalId,
      roleId: readRole.id,
      resourceKind: "namespace",
      resourceId: namespace.id,
    });
    const agentRole = await controller.createIAMRole(delegate.principalId, {
      namespaceId: namespace.id,
      permissions: [{ action: "read", resourceKind: "agent" }],
    });
    const roleIds = async () =>
      (await state.read((unit) => unit.iamPolicy.listRoles(namespace.id))).map((role) => role.id);
    const bindingIds = async () =>
      (await state.read((unit) => unit.iamPolicy.listAccessBindings(namespace.id))).map(
        (binding) => binding.id,
      );

    // A concurrent removal of the delegate's Namespace read commits after admission,
    // which reads the Namespace twice: as the policy scope and as the grant target.
    let delegateReads = 0;
    pending = {
      matches: (request) => namespaceRead(delegate.principalId)(request) && ++delegateReads === 2,
      run: () =>
        controller.deleteIAMAccessBinding(admin.principalId, namespace.id, delegateRead.id),
    };
    const before = await bindingIds();
    await assert.rejects(
      controller.createIAMAccessBinding(delegate.principalId, {
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: readRole.id,
        resourceKind: "namespace",
        resourceId: namespace.id,
      }),
      AuthorizationDeniedError,
    );
    assert.equal(pending, undefined, "the revocation raced the admitted request");
    assert.deepEqual(
      (await bindingIds()).sort(),
      before.filter((id) => id !== delegateRead.id).sort(),
    );

    // Disabling the administrator's account after admission denies the write.
    const setAdminDisabled = (disabled) =>
      pool.query(
        `UPDATE occ.human_authentication_accounts
         SET disabled = $2, version = version + 1 WHERE user_id = $1`,
        [admin.userId, disabled],
      );
    pending = {
      matches: namespaceRead(admin.principalId),
      run: () => setAdminDisabled(true),
    };
    const rolesBefore = await roleIds();
    await assert.rejects(
      controller.deleteIAMRole(admin.principalId, namespace.id, agentRole.id),
      AuthorizationDeniedError,
    );
    assert.equal(pending, undefined, "the disable raced the admitted request");
    assert.deepEqual((await roleIds()).sort(), rolesBefore.sort());
    await setAdminDisabled(false);

    // ServicePrincipal creation is a policy write too: a disable after admission creates none.
    pending = {
      matches: namespaceRead(admin.principalId),
      run: () => setAdminDisabled(true),
    };
    await assert.rejects(
      controller.createIAMServicePrincipal(admin.principalId, namespace.id),
      AuthorizationDeniedError,
    );
    assert.equal(pending, undefined, "the disable raced the admitted ServicePrincipal create");
    assert.deepEqual(
      await state.read((unit) => unit.iamPolicy.listServicePrincipals(namespace.id)),
      [],
    );
    await setAdminDisabled(false);

    // Inside the transaction, the actor's account and Namespace stay locked until
    // COMMIT: a disable or a policy write in that Namespace cannot slip in.
    const blocked = [];
    let inTransaction = 0;
    pending = {
      matches: (request) => namespaceRead(admin.principalId)(request) && ++inTransaction === 2,
      run: async () => {
        for (const [statement, parameter] of [
          [
            "UPDATE occ.human_authentication_accounts SET disabled = true WHERE user_id = $1",
            admin.userId,
          ],
          ["SELECT 1 FROM occ.namespaces WHERE id = $1 FOR UPDATE", namespace.id],
        ]) {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL lock_timeout = '200ms'");
            await client.query(statement, [parameter]);
            blocked.push(false);
          } catch (error) {
            blocked.push(isLockTimeout(error));
          } finally {
            await client.query("ROLLBACK").catch(() => {});
            client.release();
          }
        }
      },
    };
    const kept = await controller.createIAMRole(admin.principalId, {
      namespaceId: namespace.id,
      permissions: [{ action: "read", resourceKind: "agent" }],
    });
    assert.equal(pending, undefined, "the in-transaction check ran");
    assert.deepEqual(blocked, [true, true]);
    assert.ok((await roleIds()).includes(kept.id));
  },
);
