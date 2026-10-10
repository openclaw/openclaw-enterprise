import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

function identifier(kind) {
  return `${kind}_${randomUUID()}`;
}

function event(installation, namespace, agent, action) {
  return {
    id: identifier("aud"),
    installationId: installation.id,
    namespaceId: namespace.id,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    actorId: "principal-platform-state-contract",
    action,
    resource: {
      kind: "agent",
      id: agent.id,
      namespaceId: namespace.id,
    },
    outcome: "success",
  };
}

// Both stores raise the same error class for these refusals but word them differently. The
// memory store names the refusing check. PostgreSQL either enforces it with a constraint or
// trigger whose violation databaseError maps to one generic message without a cause, or refuses
// it in a broader application check (controller work shape, revision harness authentication).
// Neither store raises the other's message, so this accepts exactly the two refusals.
function storeRefusal(name, memoryMessage, postgresMessage) {
  return (error) =>
    error.name === name && (error.message === memoryMessage || error.message === postgresMessage);
}
const postgresOwnershipViolation = "The resource violates its exact platform ownership or state.";
const postgresIdentityConflict = "A platform resource with this identity or name already exists.";
// PostgreSQL refuses a wrong Agent lifecycle target in its one controller work shape check.
const postgresWorkTargetShape =
  "Controller work requires one exact Namespace, Agent, or revision target shape.";

export async function verifyPlatformStateStoreContract(store, options = {}) {
  const installation = options.installation ?? {
    id: identifier("ins"),
    name: `Platform state ${randomUUID()}`,
    createdAt: new Date().toISOString(),
  };
  const namespace = {
    id: identifier("ns"),
    name: `Namespace ${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  const configuration = {
    id: identifier("cfg"),
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  };
  const harnessSecret = {
    id: identifier("sec"),
    namespaceId: namespace.id,
    name: "Harness key " + randomUUID(),
    driverId: "secret-contract",
    backendRef: { namespaceName: "contract", name: "harness-key", key: "value", uid: randomUUID() },
    createdAt: new Date().toISOString(),
  };
  const apiKeyBinding = {
    method: "api_key",
    source: { kind: "secret", namespaceId: namespace.id, id: harnessSecret.id },
  };
  const agent = {
    id: identifier("agt"),
    namespaceId: namespace.id,
    name: `Agent ${randomUUID()}`,
    configurationId: configuration.id,
    backendId: null,
    harnessAuth: apiKeyBinding,
    executionMode: "embedded",
    servicePrincipalId: identifier("service-agent"),
    desiredRuntimeState: "stopped",
    // Both adapters force a created Agent to `active` rather than honoring a
    // caller-supplied status, so a seeded Agent must carry the same value.
    status: "active",
    createdAt: new Date().toISOString(),
  };
  const revision = {
    id: identifier("rev"),
    namespaceId: namespace.id,
    agentId: agent.id,
    revision: 1,
    backendId: null,
    configurationId: configuration.id,
    configurationKind: configuration.kind,
    configurationGeneration: configuration.generation,
    configuration: {
      models: {
        providers: {
          openai: { baseUrl: "https://api.openai.com/v1" },
        },
      },
      agents: { defaults: { model: "openai/gpt-5", maxConcurrent: 2 } },
      gateway: { controlUi: { enabled: false } },
    },
    harnessAuth: { ...apiKeyBinding, secretDriverId: harnessSecret.driverId },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: "compute-contract", implementation: "deterministic-contract" },
    servicePrincipalId: agent.servicePrincipalId,
    createdAt: new Date().toISOString(),
  };
  const audit = event(installation, namespace, agent, "deploy");
  const operation = {
    kind: "agent_revision",
    action: "reconcile",
    namespaceId: namespace.id,
    resourceId: revision.id,
    actorId: audit.actorId,
  };

  await store.transact(async (transaction) => {
    if (!options.installation) {
      assert.deepEqual(
        await transaction.installations.createInstallation(installation),
        installation,
      );
    }
    assert.deepEqual(await transaction.namespaces.createNamespace(namespace), namespace);
    assert.deepEqual(
      await transaction.configurations.createConfiguration(configuration),
      configuration,
    );
    assert.equal(await transaction.namespaces.hasConfigurations(namespace.id), true);
    assert.deepEqual(await transaction.namespaces.listConfigurationIds(namespace.id), [
      configuration.id,
    ]);
    await transaction.secrets.createSecret(harnessSecret);
    assert.deepEqual(await transaction.agents.createAgent(agent), agent);
    assert.deepEqual(await transaction.revisions.createRevision(revision), revision);
    await transaction.audit.append(audit);
    await transaction.operations.append(operation);
  });

  // The draft binding and the pending deployment both reference the key: one Agent entry.
  await store.read(async (state) => {
    assert.deepEqual(await state.secrets.listReferences(namespace.id, harnessSecret.id, 50), {
      references: [{ kind: "agent", id: agent.id }],
      truncated: false,
    });
  });

  // Agent-scoped work exists only to tear an Agent down. Reconciliation still
  // belongs to revisions, so Agent work without the deleted target is refused
  // rather than queued as generic Agent reconciliation.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.operations.append({
        kind: "agent",
        action: "reconcile",
        namespaceId: namespace.id,
        resourceId: agent.id,
        actorId: audit.actorId,
      }),
    ),
    storeRefusal(
      "ScopeViolationError",
      "Agent work does not match its exact lifecycle target.",
      postgresWorkTargetShape,
    ),
    "Agent work without a lifecycle target must not enqueue reconciliation",
  );

  await assert.rejects(
    store.transact((transaction) =>
      transaction.operations.append({
        kind: "agent",
        action: "reconcile",
        namespaceId: namespace.id,
        resourceId: agent.id,
        actorId: audit.actorId,
        target: "ready",
      }),
    ),
    storeRefusal(
      "ScopeViolationError",
      "Agent work does not match its exact lifecycle target.",
      postgresWorkTargetShape,
    ),
    "an Agent cannot be driven to a Namespace lifecycle target",
  );

  // Teardown work must name the Agent, not its owning Namespace; otherwise it
  // would be indistinguishable from Namespace work on the queue.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.operations.append({
        kind: "agent",
        action: "reconcile",
        namespaceId: namespace.id,
        resourceId: namespace.id,
        actorId: audit.actorId,
        target: "deleted",
      }),
    ),
    { name: "ScopeViolationError", message: "Agent work must name its exact Agent." },
    "teardown work naming its Namespace instead of its Agent must be refused",
  );

  const backendConfiguration = {
    id: identifier("cfg"),
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  };
  const providerAgent = {
    ...agent,
    id: identifier("agt"),
    name: `Backend owner ${randomUUID()}`,
    configurationId: backendConfiguration.id,
    backendId: "provider-a",
    servicePrincipalId: identifier("service-agent"),
  };
  await store.transact(async (transaction) => {
    await transaction.configurations.createConfiguration(backendConfiguration);
    await transaction.agents.createAgent(providerAgent);
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.revisions.createRevision({
        ...revision,
        id: identifier("rev"),
        agentId: providerAgent.id,
        configurationId: backendConfiguration.id,
        backendId: "provider-b",
        servicePrincipalId: providerAgent.servicePrincipalId,
      }),
    ),
    { name: "ScopeViolationError", message: "The AgentRevision belongs to an unavailable Agent." },
    "AgentRevision Backend snapshots must match the owning Agent.",
  );
  await store.read(async (state) => {
    assert.deepEqual(await state.revisions.listRevisions(namespace.id, providerAgent.id), []);
  });
  await store.transact(async (transaction) => {
    assert.deepEqual(
      await transaction.agents.updateConfiguration(
        namespace.id,
        providerAgent.id,
        backendConfiguration.id,
        providerAgent.executionMode,
        undefined,
        null,
      ),
      { ...providerAgent, backendId: null },
    );
  });

  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.createAgent({
        ...agent,
        id: identifier("agt"),
        name: `Duplicate principal ${randomUUID()}`,
      }),
    ),
    storeRefusal(
      "ResourceConflictError",
      "An Agent service principal already belongs to another Agent.",
      postgresIdentityConflict,
    ),
    "An Agent service principal cannot be shared with another Agent.",
  );

  for (const executionMode of [undefined, "remote", null]) {
    // Placement is an explicit, checked platform decision rather than an inferred fallback.
    await assert.rejects(
      store.transact((transaction) =>
        transaction.agents.createAgent({
          ...agent,
          id: identifier("agt"),
          name: `Invalid execution mode ${randomUUID()}`,
          executionMode,
          servicePrincipalId: identifier("service-agent"),
        }),
      ),
      storeRefusal(
        "ScopeViolationError",
        "The Agent execution mode is invalid.",
        postgresOwnershipViolation,
      ),
      `unsupported Agent execution mode ${String(executionMode)}`,
    );
  }

  await assert.rejects(
    store.transact((transaction) =>
      transaction.revisions.createRevision({
        ...revision,
        id: identifier("rev"),
        revision: 2,
        servicePrincipalId: identifier("service-agent"),
      }),
    ),
    { name: "ScopeViolationError", message: "The AgentRevision belongs to an unavailable Agent." },
    "An AgentRevision cannot claim another service principal.",
  );

  for (const [description, invalidOwnership] of [
    ["missing consumer kind", { kind: undefined }],
    ["unsupported consumer kind", { kind: "gateway" }],
    ["missing generation", { generation: undefined }],
    ["zero generation", { generation: 0 }],
    ["negative generation", { generation: -1 }],
    ["fractional generation", { generation: 1.5 }],
    ["unsafe generation", { generation: Number.MAX_SAFE_INTEGER + 1 }],
  ]) {
    // Both persistence adapters reject ownership metadata PostgreSQL cannot safely represent.
    await assert.rejects(
      store.transact((transaction) =>
        transaction.configurations.createConfiguration({
          ...configuration,
          id: identifier("cfg"),
          ...invalidOwnership,
        }),
      ),
      description,
    );
  }

  await store.read(async (state) => {
    assert.deepEqual(await state.installations.getInstallation(), installation);
    assert.deepEqual(await state.namespaces.findNamespace(namespace.id), namespace);
    assert.deepEqual(
      await state.configurations.findConfiguration(namespace.id, configuration.id),
      configuration,
    );
    assert.equal(
      await state.configurations.findConfiguration(identifier("ns"), configuration.id),
      undefined,
    );
    assert.equal(Object.hasOwn(namespace, "installationId"), false);
    assert.deepEqual(await state.agents.findAgent(namespace.id, agent.id), agent);
    assert.equal(await state.agents.findAgent(identifier("ns"), agent.id), undefined);

    const storedRevision = await state.revisions.findRevision(namespace.id, agent.id, revision.id);
    assert.deepEqual(storedRevision, revision);
    assert.ok(Object.isFrozen(storedRevision));
    assert.ok(Object.isFrozen(storedRevision.configuration));
    assert.ok(Object.isFrozen(storedRevision.harness));
    assert.ok(Object.isFrozen(storedRevision.compute));
    assert.ok(Object.isFrozen(storedRevision.harnessAuth));
    assert.ok(Object.isFrozen(storedRevision.harnessAuth.source));
    assert.equal(
      await state.revisions.findRevision(identifier("ns"), agent.id, revision.id),
      undefined,
    );
  });

  await store.transact(async (transaction) => {
    // Changing future placement never changes the placement frozen in an admitted revision.
    const dedicated = { ...agent, executionMode: "dedicated" };
    assert.deepEqual(
      await transaction.agents.updateConfiguration(
        namespace.id,
        agent.id,
        configuration.id,
        "dedicated",
      ),
      dedicated,
    );
    assert.deepEqual(
      await transaction.agents.updateConfiguration(namespace.id, agent.id, configuration.id),
      dedicated,
    );
    assert.equal(
      (await transaction.revisions.findRevision(namespace.id, agent.id, revision.id)).harness.mode,
      "embedded",
    );
    assert.deepEqual(
      await transaction.agents.updateConfiguration(
        namespace.id,
        agent.id,
        configuration.id,
        "embedded",
      ),
      agent,
    );
  });

  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.updateConfiguration(namespace.id, agent.id, configuration.id, "remote"),
    ),
    storeRefusal(
      "ScopeViolationError",
      "The Agent execution mode is invalid.",
      postgresOwnershipViolation,
    ),
    "Existing Agent placement must reject unsupported execution modes.",
  );

  for (const [description, malformed] of [
    ["missing Configuration identity", { configurationId: undefined }],
    ["malformed Configuration identity", { configurationId: "cfg_invalid" }],
    ["unsupported Configuration kind", { configurationKind: "gateway" }],
    ["missing Configuration generation", { configurationGeneration: undefined }],
    ["zero Configuration generation", { configurationGeneration: 0 }],
    ["fractional Configuration generation", { configurationGeneration: 1.5 }],
    ["unsafe Configuration generation", { configurationGeneration: Number.MAX_SAFE_INTEGER + 1 }],
    ["null draft", { configuration: null }],
    ["array draft", { configuration: [] }],
    ["missing Harness descriptor", { harness: undefined }],
    ["null Harness descriptor", { harness: null }],
    [
      "array Harness descriptor",
      { harness: Object.assign([], { id: "openclaw", version: "1.0.0", mode: "embedded" }) },
    ],
    ["missing Harness version", { harness: { id: "openclaw", mode: "embedded" } }],
    ["missing Harness mode", { harness: { id: "openclaw", version: "1.0.0" } }],
    ["unsupported Harness mode", { harness: { id: "openclaw", version: "1.0.0", mode: "remote" } }],
    ["empty Harness identity", { harness: { id: " ", version: "1.0.0", mode: "embedded" } }],
    ["empty Harness version", { harness: { id: "openclaw", version: " ", mode: "embedded" } }],
    [
      "unexpected Harness property",
      { harness: { id: "openclaw", version: "1.0.0", mode: "embedded", unexpected: true } },
    ],
    ["missing Compute descriptor", { compute: undefined }],
    ["null Compute descriptor", { compute: null }],
    [
      "array Compute descriptor",
      { compute: Object.assign([], { id: "compute-contract", implementation: "deterministic" }) },
    ],
    ["missing Compute implementation", { compute: { id: "compute-contract" } }],
    ["empty Compute identity", { compute: { id: " ", implementation: "deterministic-contract" } }],
    ["empty Compute implementation", { compute: { id: "compute-contract", implementation: " " } }],
    [
      "unexpected Compute property",
      {
        compute: {
          id: "compute-contract",
          implementation: "deterministic-contract",
          unexpected: true,
        },
      },
    ],
  ]) {
    await assert.rejects(
      store.transact((transaction) =>
        transaction.revisions.createRevision({
          ...revision,
          id: identifier("rev"),
          revision: 2,
          ...malformed,
        }),
      ),
      description,
    );
  }

  await store.read(async (state) => {
    assert.deepEqual(await state.revisions.listRevisions(namespace.id, agent.id), [revision]);
  });

  await store.transact(async (transaction) => {
    assert.deepEqual(
      await transaction.configurations.lockConfiguration(namespace.id, configuration.id),
      configuration,
    );

    // Exact Namespace ownership and the expected generation gate each atomic update.
    assert.equal(
      await transaction.configurations.advanceConfigurationGeneration(
        identifier("ns"),
        configuration.id,
        configuration.generation,
      ),
      undefined,
    );
    assert.equal(
      await transaction.configurations.advanceConfigurationGeneration(
        namespace.id,
        configuration.id,
        configuration.generation + 1,
      ),
      undefined,
    );

    const advanced = await transaction.configurations.advanceConfigurationGeneration(
      namespace.id,
      configuration.id,
      configuration.generation,
    );
    assert.deepEqual(advanced, { ...configuration, generation: 2 });
    assert.equal(
      await transaction.configurations.advanceConfigurationGeneration(
        namespace.id,
        configuration.id,
        configuration.generation,
      ),
      undefined,
      "A stale writer cannot advance the same Configuration generation twice.",
    );

    // Configuration changes never rewrite an already-admitted immutable revision.
    assert.deepEqual(
      await transaction.revisions.findRevision(namespace.id, agent.id, revision.id),
      revision,
    );
  });

  // A failed transaction cannot publish a generation that was only advanced speculatively.
  await assert.rejects(
    store.transact(async (transaction) => {
      assert.equal(
        (
          await transaction.configurations.advanceConfigurationGeneration(
            namespace.id,
            configuration.id,
            2,
          )
        ).generation,
        3,
      );
      throw new Error("simulated Configuration transaction failure");
    }),
    /simulated Configuration transaction failure/,
  );
  await store.read(async (state) => {
    assert.deepEqual(await state.configurations.findConfiguration(namespace.id, configuration.id), {
      ...configuration,
      generation: 2,
    });
  });

  await assert.rejects(
    store.transact((transaction) =>
      transaction.configurations.deleteConfiguration(namespace.id, configuration.id),
    ),
    storeRefusal(
      "ScopeViolationError",
      "The Configuration is referenced by an Agent.",
      postgresOwnershipViolation,
    ),
    "A Configuration referenced by an Agent cannot be deleted.",
  );

  const rejectedNamespace = {
    ...namespace,
    id: identifier("ns"),
    name: `Rolled back ${randomUUID()}`,
  };
  const rejectedAudit = event(installation, namespace, agent, "rollback");
  const rejectedOperation = {
    kind: "namespace",
    action: "reconcile",
    target: "ready",
    namespaceId: rejectedNamespace.id,
    resourceId: rejectedNamespace.id,
    actorId: audit.actorId,
  };

  const transactionFailure = new Error("simulated transaction failure");
  let escapedTransaction;
  await assert.rejects(
    store.transact(async (transaction) => {
      escapedTransaction = transaction;
      await transaction.namespaces.createNamespace(rejectedNamespace);
      await transaction.audit.append(rejectedAudit);
      await transaction.operations.append(rejectedOperation);
      throw transactionFailure;
    }),
    (error) => error === transactionFailure,
  );

  // Use a fresh identity so a duplicate-row conflict cannot masquerade as a
  // closed transaction when the rolled-back memory snapshot is retained.
  await assert.rejects(
    escapedTransaction.namespaces.createNamespace({
      ...rejectedNamespace,
      id: identifier("ns"),
      name: `Escaped ${randomUUID()}`,
    }),
    { name: "ScopeViolationError", message: "The platform transaction is closed." },
  );

  await store.read(async (state) => {
    assert.equal(await state.namespaces.findNamespace(rejectedNamespace.id), undefined);
  });

  await store.transact(async (transaction) => {
    assert.ok((await transaction.audit.list()).some(({ id }) => id === audit.id));
    assert.ok(!(await transaction.audit.list()).some(({ id }) => id === rejectedAudit.id));
    assert.ok(
      (await transaction.operations.list()).some(({ resourceId }) => resourceId === revision.id),
    );
    assert.ok(
      !(await transaction.operations.list()).some(
        ({ resourceId }) => resourceId === rejectedNamespace.id,
      ),
    );
  });

  const lifecycleNamespace = {
    id: identifier("ns"),
    name: `Lifecycle ${randomUUID()}`,
    existingNamespace: `existing-${randomUUID()}`,
    status: "provisioning",
    createdAt: new Date().toISOString(),
  };
  const blockedAgent = {
    ...agent,
    id: identifier("agt"),
    namespaceId: lifecycleNamespace.id,
    name: `Blocked ${randomUUID()}`,
    servicePrincipalId: identifier("service-agent"),
  };
  const deletedAt = new Date(Date.now() + 1).toISOString();

  await store.transact((transaction) => transaction.namespaces.createNamespace(lifecycleNamespace));

  // Two live platform tenants cannot concurrently claim the same existing Kubernetes namespace.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.namespaces.createNamespace({
        ...lifecycleNamespace,
        id: identifier("ns"),
        name: `Duplicate existing namespace ${randomUUID()}`,
      }),
    ),
    storeRefusal(
      "ResourceConflictError",
      "The existing Kubernetes namespace is already assigned to a Namespace.",
      postgresIdentityConflict,
    ),
    "An existing Kubernetes namespace cannot be assigned to multiple live platform Namespaces.",
  );

  await store.transact(async (transaction) => {
    assert.equal(
      (await transaction.namespaces.findNamespace(lifecycleNamespace.id)).existingNamespace,
      lifecycleNamespace.existingNamespace,
    );
    assert.equal(
      (await transaction.namespaces.lockNamespace(lifecycleNamespace.id)).existingNamespace,
      lifecycleNamespace.existingNamespace,
    );
    await transaction.operations.append({
      kind: "namespace",
      action: "reconcile",
      target: "ready",
      namespaceId: lifecycleNamespace.id,
      resourceId: lifecycleNamespace.id,
      actorId: audit.actorId,
    });
    assert.equal(
      await transaction.namespaces.transitionNamespaceStatus(
        lifecycleNamespace.id,
        "failed",
        "ready",
      ),
      undefined,
    );
    const readyNamespace = await transaction.namespaces.transitionNamespaceStatus(
      lifecycleNamespace.id,
      "provisioning",
      "ready",
    );
    assert.equal(readyNamespace.status, "ready");
    assert.equal(readyNamespace.existingNamespace, lifecycleNamespace.existingNamespace);
    assert.equal(
      (
        await transaction.namespaces.transitionNamespaceStatus(
          lifecycleNamespace.id,
          "ready",
          "deleting",
        )
      ).status,
      "deleting",
    );
    await transaction.operations.append({
      kind: "namespace",
      action: "reconcile",
      target: "deleted",
      namespaceId: lifecycleNamespace.id,
      resourceId: lifecycleNamespace.id,
      actorId: audit.actorId,
    });
    assert.equal(await transaction.namespaces.hasAgents(lifecycleNamespace.id), false);
    await assert.rejects(transaction.agents.createAgent(blockedAgent), {
      name: "ScopeViolationError",
    });
    // A Namespace being deleted admits no new ServicePrincipal either.
    await assert.rejects(
      transaction.iamPolicy.createServicePrincipal({
        kind: "service_principal",
        id: identifier("spn"),
        namespaceId: lifecycleNamespace.id,
      }),
      { name: "ScopeViolationError" },
    );
    const tombstone = await transaction.namespaces.markNamespaceDeleted(
      lifecycleNamespace.id,
      deletedAt,
    );
    assert.equal(tombstone.deletedAt, deletedAt);
    assert.equal(tombstone.existingNamespace, lifecycleNamespace.existingNamespace);
    assert.deepEqual(
      await transaction.namespaces.markNamespaceDeleted(lifecycleNamespace.id, deletedAt),
      tombstone,
    );
  });

  // A deleted failed attempt releases its reservation; physical ownership is still checked by Kubernetes.
  const retryNamespace = await store.transact((transaction) =>
    transaction.namespaces.createNamespace({
      ...lifecycleNamespace,
      id: identifier("ns"),
      name: `Retry existing namespace ${randomUUID()}`,
    }),
  );
  assert.equal(retryNamespace.existingNamespace, lifecycleNamespace.existingNamespace);

  // The tombstone keeps its name, and the conflict says the name belongs to a deleted Namespace.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.namespaces.createNamespace({
        ...lifecycleNamespace,
        id: identifier("ns"),
        existingNamespace: undefined,
      }),
    ),
    {
      name: "ResourceStateConflictError",
      message:
        "This name belongs to a deleted Namespace and cannot be reused. Choose a different name.",
    },
  );

  await assert.rejects(
    store.transact((transaction) =>
      transaction.namespaces.createNamespace({
        ...lifecycleNamespace,
        id: identifier("ns"),
        name: `Invalid existing namespace ${randomUUID()}`,
        existingNamespace: "Invalid.Namespace",
      }),
    ),
    storeRefusal(
      "ScopeViolationError",
      "The existing Kubernetes namespace name is invalid.",
      postgresOwnershipViolation,
    ),
    "An existing Kubernetes namespace must be a valid lowercase DNS label.",
  );

  await store.read(async (state) => {
    assert.equal(await state.namespaces.findNamespace(lifecycleNamespace.id), undefined);
    assert.ok(
      !(await state.namespaces.listNamespaces()).some(({ id }) => id === lifecycleNamespace.id),
    );
  });

  await store.transact(async (transaction) => {
    assert.equal(await transaction.namespaces.lockNamespace(lifecycleNamespace.id), undefined);
    assert.equal(
      (
        await transaction.namespaces.lockNamespace(lifecycleNamespace.id, {
          includeDeleted: true,
        })
      ).deletedAt,
      deletedAt,
    );
    assert.deepEqual(
      (await transaction.operations.list())
        .filter(({ resourceId }) => resourceId === lifecycleNamespace.id)
        .map(({ target }) => target)
        .sort(),
      ["deleted", "ready"],
    );
  });

  const accountNamespace = {
    id: identifier("ns"),
    name: "Service accounts " + randomUUID(),
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  const accountConfiguration = {
    id: identifier("cfg"),
    namespaceId: accountNamespace.id,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  };
  const account = {
    id: identifier("sa"),
    namespaceId: accountNamespace.id,
    name: "Account " + randomUUID(),
  };
  const credential = {
    kind: "access_token",
    secretRef: { name: "account-source.credentials", key: "account-token" },
  };
  const alternateCredential = {
    kind: "access_token",
    secretRef: { name: "rotated-source", key: "next-account-token" },
  };
  const alternateAccount = {
    id: identifier("sa"),
    namespaceId: accountNamespace.id,
    name: "Alternate " + randomUUID(),
    credential,
  };
  const accountAgent = {
    id: identifier("agt"),
    namespaceId: accountNamespace.id,
    name: "Account agent " + randomUUID(),
    configurationId: accountConfiguration.id,
    backendId: null,
    executionMode: "dedicated",
    servicePrincipalId: identifier("service-agent"),
    harnessAuth: {
      method: "codex_pat",
      source: { kind: "service_account", namespaceId: account.namespaceId, id: account.id },
    },
    desiredRuntimeState: "stopped",
    status: "active",
    createdAt: new Date().toISOString(),
  };
  const sharedAccountAgent = {
    ...accountAgent,
    id: identifier("agt"),
    name: "Shared account agent " + randomUUID(),
    servicePrincipalId: identifier("service-agent"),
  };
  const accountRevision = {
    ...revision,
    id: identifier("rev"),
    namespaceId: accountNamespace.id,
    agentId: accountAgent.id,
    configurationId: accountConfiguration.id,
    configurationGeneration: accountConfiguration.generation,
    servicePrincipalId: accountAgent.servicePrincipalId,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: {
      method: "codex_pat",
      source: { kind: "service_account", namespaceId: account.namespaceId, id: account.id },
      credential,
      backendBinding: {
        backendId: "chatgpt-contract",
        driverId: "service-account-contract",
        workspaceId: "workspace-contract",
        credentialIssued: true,
      },
    },
  };

  await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(accountNamespace);
    await transaction.configurations.createConfiguration(accountConfiguration);
    assert.equal(await transaction.namespaces.hasServiceAccounts(accountNamespace.id), false);
    assert.deepEqual(await transaction.serviceAccounts.createServiceAccount(account), account);
    assert.equal(await transaction.namespaces.hasServiceAccounts(accountNamespace.id), true);
    assert.deepEqual(
      await transaction.serviceAccounts.updateCredential(
        accountNamespace.id,
        account.id,
        credential,
      ),
      { ...account, credential },
    );
    assert.deepEqual(
      await transaction.serviceAccounts.createServiceAccount(alternateAccount),
      alternateAccount,
    );
    assert.deepEqual(await transaction.agents.createAgent(accountAgent), accountAgent);
    assert.deepEqual(await transaction.agents.createAgent(sharedAccountAgent), sharedAccountAgent);
    assert.deepEqual(await transaction.revisions.createRevision(accountRevision), accountRevision);
  });

  const oauthCredential = {
    kind: "oauth_access_token",
    secretRef: { name: "oauth-reference", key: "access-token" },
  };
  await store.transact(async (transaction) => {
    const updated = await transaction.serviceAccounts.updateCredential(
      accountNamespace.id,
      account.id,
      oauthCredential,
    );
    assert.deepEqual(updated.credential, oauthCredential);
    await transaction.serviceAccounts.updateCredential(accountNamespace.id, account.id, credential);
  });

  // ChatGPT revisions require an exact issued access-token reference with safe Secret keys.
  for (const invalidCredential of [
    oauthCredential,
    { ...credential, kind: "api_key" },
    ...[".", ".."].map((key) => ({ ...credential, secretRef: { ...credential.secretRef, key } })),
  ]) {
    await assert.rejects(
      store.transact((transaction) =>
        transaction.revisions.createRevision({
          ...accountRevision,
          id: identifier("rev"),
          revision: 2,
          harnessAuth: {
            ...accountRevision.harnessAuth,
            credential: invalidCredential,
          },
        }),
      ),
      storeRefusal(
        "ScopeViolationError",
        "An AgentRevision requires valid Configuration metadata, a native document, and pinned Harness and Compute descriptors.",
        "The AgentRevision harness authentication is invalid or legacy.",
      ),
      "Admitted revisions reject unsupported credentials and unsafe Secret keys.",
    );
  }
  // The admitted ServiceAccount source belongs to the revision's own Namespace, even when
  // the account ID exists there.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.revisions.createRevision({
        ...accountRevision,
        id: identifier("rev"),
        revision: 2,
        harnessAuth: {
          ...accountRevision.harnessAuth,
          source: { ...accountRevision.harnessAuth.source, namespaceId: namespace.id },
        },
      }),
    ),
    storeRefusal(
      "ScopeViolationError",
      "An AgentRevision requires valid Configuration metadata, a native document, and pinned Harness and Compute descriptors.",
      "The AgentRevision harness authentication is invalid or legacy.",
    ),
    "Admitted revisions reject a ServiceAccount source naming another Namespace.",
  );
  // A revision admits exactly the account its Agent is bound to, not a sibling account.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.revisions.createRevision({
        ...accountRevision,
        id: identifier("rev"),
        revision: 2,
        harnessAuth: {
          ...accountRevision.harnessAuth,
          source: { ...accountRevision.harnessAuth.source, id: alternateAccount.id },
        },
      }),
    ),
    { name: "ScopeViolationError", message: "The AgentRevision belongs to an unavailable Agent." },
    "Admitted revisions reject an account other than the Agent's binding.",
  );

  await store.read(async (state) => {
    const stored = await state.serviceAccounts.findServiceAccount(accountNamespace.id, account.id);
    assert.deepEqual(stored, { ...account, credential });
    for (const value of [stored, stored.credential, stored.credential.secretRef]) {
      assert.ok(Object.isFrozen(value));
    }
    assert.equal(
      await state.serviceAccounts.findServiceAccount(namespace.id, account.id),
      undefined,
      "A ServiceAccount cannot be read from another Namespace.",
    );
    const snapshot = await state.revisions.findRevision(
      accountNamespace.id,
      accountAgent.id,
      accountRevision.id,
    );
    assert.deepEqual(snapshot.harnessAuth, accountRevision.harnessAuth);
    for (const value of [
      snapshot.harnessAuth,
      snapshot.harnessAuth.credential,
      snapshot.harnessAuth.credential.secretRef,
      snapshot.harnessAuth.backendBinding,
    ]) {
      assert.ok(Object.isFrozen(value));
    }
  });

  await assert.rejects(
    store.transact((transaction) =>
      transaction.serviceAccounts.createServiceAccount({ ...account, id: identifier("sa") }),
    ),
    {
      name: "ResourceStateConflictError",
      message:
        "A ServiceAccount with this name already exists in this Namespace. Choose a different name.",
    },
    "ServiceAccount names must be unique within their Namespace.",
  );

  for (const [description, invalidCredential] of [
    ["unsupported credential kind", { kind: "bearer", secretRef: credential.secretRef }],
    [
      "invalid source Secret name",
      { ...credential, secretRef: { name: "../foreign", key: "valid" } },
    ],
    ["invalid source Secret key", { ...credential, secretRef: { name: "valid", key: "../token" } }],
    [
      "current-directory source Secret key",
      { ...credential, secretRef: { name: "valid", key: "." } },
    ],
    [
      "parent-directory source Secret key",
      { ...credential, secretRef: { name: "valid", key: ".." } },
    ],
  ]) {
    await assert.rejects(
      store.transact((transaction) =>
        transaction.serviceAccounts.updateCredential(
          accountNamespace.id,
          account.id,
          invalidCredential,
        ),
      ),
      description,
    );
  }
  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.createAgent({
        ...agent,
        id: identifier("agt"),
        name: "Cross Namespace " + randomUUID(),
        servicePrincipalId: identifier("service-agent"),
        harnessAuth: {
          method: "codex_pat",
          source: { kind: "service_account", namespaceId: account.namespaceId, id: account.id },
        },
      }),
    ),
    {
      name: "ScopeViolationError",
      message: "The Agent harness authentication references an unavailable ServiceAccount.",
    },
    "An Agent cannot associate a ServiceAccount from another Namespace.",
  );
  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.updateConfiguration(namespace.id, agent.id, configuration.id, undefined, {
        method: "codex_pat",
        source: { kind: "service_account", namespaceId: account.namespaceId, id: account.id },
      }),
    ),
    {
      name: "ScopeViolationError",
      message: "The Agent harness authentication references an unavailable ServiceAccount.",
    },
    "An existing Agent cannot associate a ServiceAccount from another Namespace.",
  );
  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.updateConfiguration(
        accountNamespace.id,
        accountAgent.id,
        accountConfiguration.id,
        undefined,
        {
          method: "codex_pat",
          source: { kind: "service_account", namespaceId: namespace.id, id: account.id },
        },
      ),
    ),
    {
      name: "ScopeViolationError",
      message: "The Agent harness authentication references an unavailable ServiceAccount.",
    },
    "A source naming another Namespace is refused even when the account ID exists here.",
  );
  await assert.rejects(
    store.transact((transaction) =>
      transaction.serviceAccounts.deleteServiceAccount(accountNamespace.id, account.id),
    ),
    {
      name: "ScopeViolationError",
      message: "The ServiceAccount is referenced by active platform state.",
    },
    "An Agent-bound ServiceAccount cannot be deleted.",
  );

  await store.transact(async (transaction) => {
    assert.ok(
      await transaction.serviceAccounts.lockServiceAccount(accountNamespace.id, account.id),
    );
    await transaction.serviceAccounts.updateCredential(
      accountNamespace.id,
      account.id,
      alternateCredential,
    );
    // Credential updates affect future deployments, never an admitted immutable revision.
    assert.deepEqual(
      (
        await transaction.revisions.findRevision(
          accountNamespace.id,
          accountAgent.id,
          accountRevision.id,
        )
      ).harnessAuth,
      accountRevision.harnessAuth,
    );
    const alternateBinding = {
      method: "codex_pat",
      source: {
        kind: "service_account",
        namespaceId: alternateAccount.namespaceId,
        id: alternateAccount.id,
      },
    };
    for (const [requested, expected] of [
      [alternateBinding, alternateBinding],
      [undefined, alternateBinding],
      [null, null],
    ]) {
      const updated = await transaction.agents.updateConfiguration(
        accountNamespace.id,
        accountAgent.id,
        accountConfiguration.id,
        undefined,
        requested,
      );
      assert.deepEqual(updated.harnessAuth, expected);
    }
  });

  await assert.rejects(
    store.transact(async (transaction) => {
      await transaction.serviceAccounts.updateCredential(
        accountNamespace.id,
        account.id,
        credential,
      );
      throw new Error("simulated ServiceAccount credential transaction failure");
    }),
    /simulated ServiceAccount credential transaction failure/,
  );
  assert.deepEqual(
    await store.read((state) =>
      state.serviceAccounts.findServiceAccount(accountNamespace.id, account.id),
    ),
    { ...account, credential: alternateCredential },
  );

  await store.transact(async (transaction) => {
    // The second consumer's draft still blocks deletion after the first consumer detaches.
    assert.equal(
      await transaction.serviceAccounts.hasReferences(accountNamespace.id, account.id),
      true,
    );
    assert.equal(await transaction.serviceAccounts.hasReferences(namespace.id, account.id), false);
    await transaction.agents.updateConfiguration(
      accountNamespace.id,
      sharedAccountAgent.id,
      accountConfiguration.id,
      undefined,
      null,
    );
    assert.equal(
      await transaction.serviceAccounts.hasReferences(accountNamespace.id, account.id),
      false,
    );
    // Completed deployment state has an active pointer even after every draft detaches.
    await transaction.agents.compareAndSetActiveRevision(
      accountNamespace.id,
      accountAgent.id,
      undefined,
      accountRevision.id,
    );
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.serviceAccounts.deleteServiceAccount(accountNamespace.id, account.id),
    ),
    {
      name: "ScopeViolationError",
      message: "The ServiceAccount is referenced by active platform state.",
    },
    "An active revision must protect its account even without pending work or draft references.",
  );
  await store.transact(async (transaction) => {
    const replacementBinding = {
      method: "codex_pat",
      source: {
        kind: "service_account",
        namespaceId: alternateAccount.namespaceId,
        id: alternateAccount.id,
      },
    };
    await transaction.agents.updateConfiguration(
      accountNamespace.id,
      accountAgent.id,
      accountConfiguration.id,
      undefined,
      replacementBinding,
    );
    const replacement = await transaction.revisions.createRevision({
      ...accountRevision,
      harnessAuth: { ...accountRevision.harnessAuth, source: replacementBinding.source },
      id: identifier("rev"),
      revision: 2,
    });
    await transaction.agents.compareAndSetActiveRevision(
      accountNamespace.id,
      accountAgent.id,
      accountRevision.id,
      replacement.id,
    );
    // Retaining an inactive historical snapshot does not retain the upstream account forever.
    assert.equal(
      await transaction.serviceAccounts.hasReferences(accountNamespace.id, account.id),
      false,
    );
  });

  const accountOnlyNamespace = {
    id: identifier("ns"),
    name: "Account-only " + randomUUID(),
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  const accountOnly = {
    id: identifier("sa"),
    namespaceId: accountOnlyNamespace.id,
    name: "Remaining account " + randomUUID(),
  };
  await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(accountOnlyNamespace);
    await transaction.serviceAccounts.createServiceAccount(accountOnly);
    assert.equal(await transaction.namespaces.hasServiceAccounts(accountOnlyNamespace.id), true);
    await transaction.namespaces.transitionNamespaceStatus(
      accountOnlyNamespace.id,
      "ready",
      "deleting",
    );
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.namespaces.markNamespaceDeleted(
        accountOnlyNamespace.id,
        new Date(Date.now() + 1).toISOString(),
      ),
    ),
    storeRefusal(
      "ScopeViolationError",
      "A nonempty Namespace cannot be tombstoned.",
      postgresOwnershipViolation,
    ),
    "A Namespace containing only a ServiceAccount cannot be tombstoned.",
  );
  await store.transact(async (transaction) => {
    assert.equal(
      await transaction.serviceAccounts.deleteServiceAccount(
        accountOnlyNamespace.id,
        accountOnly.id,
      ),
      true,
    );
    assert.equal(await transaction.namespaces.hasServiceAccounts(accountOnlyNamespace.id), false);
    assert.ok(
      await transaction.namespaces.markNamespaceDeleted(
        accountOnlyNamespace.id,
        new Date(Date.now() + 1).toISOString(),
      ),
    );
  });

  // Agent deletion is asynchronous, so the status transition is the boundary
  // that stops concurrent mutations from admitting work an in-flight teardown
  // has already enumerated. A dedicated Agent keeps the seeded one usable.
  const lifecycleAgent = {
    ...agent,
    id: identifier("agt"),
    name: `Lifecycle ${randomUUID()}`,
    servicePrincipalId: identifier("service-agent"),
  };
  await store.transact(async (transaction) => {
    const created = await transaction.agents.createAgent(lifecycleAgent);
    assert.equal(created.status, "active", "a created Agent is active");

    // An absent Agent is reported as undefined rather than raising, so callers
    // cannot distinguish a missing Agent from a refused transition.
    assert.equal(
      await transaction.agents.transitionAgentStatus(
        lifecycleAgent.namespaceId,
        identifier("agt"),
        "active",
        "deleting",
      ),
      undefined,
    );

    // A status the Agent does not currently hold does not match.
    assert.equal(
      await transaction.agents.transitionAgentStatus(
        lifecycleAgent.namespaceId,
        lifecycleAgent.id,
        "deleting",
        "deleting",
      ),
      undefined,
    );

    const deleting = await transaction.agents.transitionAgentStatus(
      lifecycleAgent.namespaceId,
      lifecycleAgent.id,
      "active",
      "deleting",
    );
    assert.equal(deleting.status, "deleting");

    // The same call no longer matches, because the Agent has left active. A
    // caller that treats a repeated deletion request as success checks the
    // status first rather than relying on the transition, as deleteNamespace does.
    assert.equal(
      await transaction.agents.transitionAgentStatus(
        lifecycleAgent.namespaceId,
        lifecycleAgent.id,
        "active",
        "deleting",
      ),
      undefined,
    );

    // Re-entering the state the Agent already holds is permitted, so a retry
    // that has already observed `deleting` converges instead of conflicting.
    const unchanged = await transaction.agents.transitionAgentStatus(
      lifecycleAgent.namespaceId,
      lifecycleAgent.id,
      "deleting",
      "deleting",
    );
    assert.equal(unchanged.status, "deleting");
  });

  // Deleting is terminal: teardown removes the row, so nothing returns to active.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.transitionAgentStatus(
        lifecycleAgent.namespaceId,
        lifecycleAgent.id,
        "deleting",
        "active",
      ),
    ),
    storeRefusal(
      "ScopeViolationError",
      "The Agent lifecycle transition is invalid.",
      postgresOwnershipViolation,
    ),
    "A deleting Agent cannot return to active.",
  );

  // A created Agent always lands active; a caller cannot seed one mid-deletion.
  await store.transact(async (transaction) => {
    const seeded = await transaction.agents.createAgent({
      ...agent,
      id: identifier("agt"),
      name: `Seeded deleting ${randomUUID()}`,
      servicePrincipalId: identifier("service-agent"),
      status: "deleting",
    });
    assert.equal(seeded.status, "active");
  });

  // Agent teardown work carries no revision, unlike revision reconciliation.
  // It must survive persistence and be read back as Agent work rather than
  // being mistaken for Namespace work, which is the other revision-less shape.
  const teardownOperation = {
    kind: "agent",
    action: "reconcile",
    namespaceId: lifecycleAgent.namespaceId,
    resourceId: lifecycleAgent.id,
    actorId: audit.actorId,
    target: "deleted",
  };
  await store.transact((transaction) => transaction.operations.append(teardownOperation));
  await store.transact(async (transaction) => {
    const queued = (await transaction.operations.list()).filter(
      (candidate) => candidate.resourceId === lifecycleAgent.id,
    );
    assert.equal(queued.length, 1, "exactly one teardown item is queued for the Agent");
    assert.deepEqual(queued[0], teardownOperation);
  });

  // Re-requesting teardown converges on the queued item instead of duplicating
  // it, so a retried deletion request cannot enqueue a second teardown.
  await store.transact((transaction) => transaction.operations.append(teardownOperation));
  await store.transact(async (transaction) => {
    assert.equal(
      (await transaction.operations.list()).filter(
        (candidate) => candidate.resourceId === lifecycleAgent.id,
      ).length,
      1,
    );
  });

  // Teardown cannot be queued against an Agent that does not exist in the
  // exact owning Namespace.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.operations.append({ ...teardownOperation, resourceId: identifier("agt") }),
    ),
    { name: "ScopeViolationError", message: "Agent work does not match its exact owner." },
    "teardown work for an absent Agent must be refused",
  );

  await verifyCredentialSourceContract(store, {
    namespace,
    harnessSecret,
    accountNamespace,
    accountConfiguration,
    accountAgent,
    revision,
  });

  await verifyDeletedResourceAccessBindingContract(store, revision);
  await verifyDuplicateNameContract(store);
  await verifyNameLengthContract(store);

  return {
    installation,
    namespace,
    agent,
    configuration,
    revision,
    audit,
    operation,
    lifecycleAgent,
    serviceAccount: { ...account, credential: alternateCredential },
    serviceAccountNamespace: accountNamespace,
    serviceAccountRevision: accountRevision,
    lifecycleNamespace,
    deletedAt,
  };
}

// A duplicate caller-chosen name is a ResourceStateConflictError whose message names the
// taken kind, alike in both adapters; a server-generated identity collision stays generic.
async function verifyDuplicateNameContract(store) {
  const createdAt = new Date().toISOString();
  const namespace = {
    id: identifier("ns"),
    name: "Duplicate names " + randomUUID(),
    status: "ready",
    createdAt,
  };
  const secret = {
    id: identifier("sec"),
    namespaceId: namespace.id,
    name: "Taken secret " + randomUUID(),
    driverId: "secret-contract",
    backendRef: {
      namespaceName: "contract",
      name: "duplicate-names",
      key: "value",
      uid: randomUUID(),
    },
    createdAt,
  };
  const presetFor = (name) => ({
    id: identifier("pre"),
    namespaceId: namespace.id,
    name: name + " " + randomUUID(),
    createdAt,
    template: {
      variables: {},
      agent: { name: "Assistant", executionMode: "embedded" },
      configuration: { values: {} },
    },
  });
  const preset = presetFor("Taken preset");
  const otherPreset = presetFor("Other preset");
  const account = {
    id: identifier("sa"),
    namespaceId: namespace.id,
    name: "Taken account " + randomUUID(),
  };
  const source = {
    id: identifier("cs"),
    namespaceId: namespace.id,
    name: "Taken source " + randomUUID(),
    type: "openai",
    config: { base_url: "https://api.openai.com/v1" },
    secrets: {},
    driverId: "credential-gateway-contract",
    state: "ready",
    createdAt,
  };

  await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(namespace);
    await transaction.secrets.createSecret(secret);
    await transaction.presets.createPreset(preset);
    await transaction.presets.createPreset(otherPreset);
    await transaction.serviceAccounts.createServiceAccount(account);
    await transaction.credentialSources.createCredentialSource(source);
  });

  const nameConflict = (message) => ({ name: "ResourceStateConflictError", message });
  for (const [write, message] of [
    [
      (transaction) =>
        transaction.namespaces.createNamespace({ ...namespace, id: identifier("ns") }),
      "A Namespace with this name already exists. Choose a different name.",
    ],
    [
      (transaction) => transaction.secrets.createSecret({ ...secret, id: identifier("sec") }),
      "A Secret with this name already exists in this Namespace. Choose a different name.",
    ],
    [
      (transaction) => transaction.presets.createPreset({ ...preset, id: identifier("pre") }),
      "A Preset with this name already exists in this Namespace. Choose a different name.",
    ],
    [
      (transaction) =>
        transaction.presets.updatePreset(namespace.id, otherPreset.id, { name: preset.name }),
      "A Preset with this name already exists in this Namespace. Choose a different name.",
    ],
    [
      (transaction) =>
        transaction.serviceAccounts.createServiceAccount({ ...account, id: identifier("sa") }),
      "A ServiceAccount with this name already exists in this Namespace. Choose a different name.",
    ],
    [
      (transaction) =>
        transaction.credentialSources.createCredentialSource({ ...source, id: identifier("cs") }),
      "A credential source with this name already exists in this Namespace. Choose a different name.",
    ],
  ]) {
    await assert.rejects(store.transact(write), nameConflict(message));
  }

  // The server chose the identity, so its collision keeps the generic conflict.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.secrets.createSecret({ ...secret, name: "Fresh secret " + randomUUID() }),
    ),
    (error) => error.name === "ResourceConflictError",
  );
}

// Names hold up to 200 characters counted as code points, as the API contract and
// PostgreSQL char_length count them: a name of astral characters (two UTF-16 code units
// each) is accepted at 200 by both adapters, and a Secret, ServiceAccount or credential
// source name is refused at 201 (the memory adapter has no Preset name length check).
async function verifyNameLengthContract(store) {
  const createdAt = new Date().toISOString();
  // 190 emoji and a 10-character unique suffix: 200 code points, 390 UTF-16 code units.
  const nameOf = (count) => "\u{1F600}".repeat(count) + randomUUID().slice(0, 10);
  const namespace = { id: identifier("ns"), name: nameOf(190), status: "ready", createdAt };
  const secret = (name) => ({
    id: identifier("sec"),
    namespaceId: namespace.id,
    name,
    driverId: "secret-contract",
    backendRef: { namespaceName: "contract", name: "long-names", key: "value", uid: randomUUID() },
    createdAt,
  });
  const account = (name) => ({ id: identifier("sa"), namespaceId: namespace.id, name });
  const source = (name) => ({
    id: identifier("cs"),
    namespaceId: namespace.id,
    name,
    type: "openai",
    config: { base_url: "https://api.openai.com/v1" },
    secrets: {},
    driverId: "credential-gateway-contract",
    state: "ready",
    createdAt,
  });
  const preset = (name) => ({
    id: identifier("pre"),
    namespaceId: namespace.id,
    name,
    createdAt,
    template: { variables: {}, configuration: { values: {} } },
  });
  const accepted = { secret: secret(nameOf(190)), account: account(nameOf(190)) };
  accepted.source = source(nameOf(190));
  accepted.preset = preset(nameOf(190));
  await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(namespace);
    await transaction.secrets.createSecret(accepted.secret);
    await transaction.serviceAccounts.createServiceAccount(accepted.account);
    await transaction.credentialSources.createCredentialSource(accepted.source);
    await transaction.presets.createPreset(accepted.preset);
  });
  await store.read(async (transaction) => {
    assert.equal(
      (await transaction.secrets.findSecret(namespace.id, accepted.secret.id))?.name,
      accepted.secret.name,
    );
    assert.equal(
      (await transaction.serviceAccounts.findServiceAccount(namespace.id, accepted.account.id))
        ?.name,
      accepted.account.name,
    );
    assert.equal(
      (await transaction.credentialSources.findCredentialSource(namespace.id, accepted.source.id))
        ?.name,
      accepted.source.name,
    );
    assert.equal(
      (await transaction.presets.findPreset(namespace.id, accepted.preset.id))?.name,
      accepted.preset.name,
    );
  });

  for (const write of [
    (transaction) => transaction.secrets.createSecret(secret(nameOf(191))),
    (transaction) => transaction.serviceAccounts.createServiceAccount(account(nameOf(191))),
    (transaction) => transaction.credentialSources.createCredentialSource(source(nameOf(191))),
  ]) {
    await assert.rejects(store.transact(write), { name: "ScopeViolationError" });
  }
}

// Deleting a Configuration, Preset, Secret, credential source or ServiceAccount
// removes the AccessBindings that grant on it, so none outlives its target or
// keeps the Role it references from being deleted.
async function verifyDeletedResourceAccessBindingContract(store, revision) {
  const createdAt = new Date().toISOString();
  const namespace = {
    id: identifier("ns"),
    name: "Binding cleanup " + randomUUID(),
    status: "ready",
    createdAt,
  };
  const secretFor = (name) => ({
    id: identifier("sec"),
    namespaceId: namespace.id,
    name: name + " " + randomUUID(),
    driverId: "secret-contract",
    backendRef: {
      namespaceName: "contract",
      name: "binding-cleanup",
      key: "value",
      uid: randomUUID(),
    },
    createdAt,
  });
  const configurationFor = () => ({
    id: identifier("cfg"),
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt,
  });
  const agentConfiguration = configurationFor();
  const agentSecret = secretFor("Agent key");
  const agent = {
    id: identifier("agt"),
    namespaceId: namespace.id,
    name: "Binding subject " + randomUUID(),
    configurationId: agentConfiguration.id,
    backendId: null,
    harnessAuth: {
      method: "api_key",
      source: { kind: "secret", namespaceId: namespace.id, id: agentSecret.id },
    },
    executionMode: "embedded",
    servicePrincipalId: identifier("service-agent"),
    desiredRuntimeState: "stopped",
    status: "active",
    createdAt,
  };
  const secret = secretFor("Bound secret");
  const configuration = {
    ...configurationFor(),
    secretBindings: {
      SLACK_BOT_TOKEN: { source: { kind: "secret", namespaceId: namespace.id, id: secret.id } },
    },
  };
  const secondConfiguration = { ...configuration, ...configurationFor() };
  const configurationIds = [configuration.id, secondConfiguration.id].sort();
  const preset = {
    id: identifier("pre"),
    namespaceId: namespace.id,
    name: "Bound preset " + randomUUID(),
    createdAt,
    template: {
      variables: {},
      agent: { name: "Assistant", executionMode: "embedded" },
      configuration: { values: {} },
    },
  };
  const source = {
    id: identifier("cs"),
    namespaceId: namespace.id,
    name: "Bound source " + randomUUID(),
    type: "openai",
    config: { base_url: "https://api.openai.com/v1" },
    secrets: { api_key: { kind: "secret", namespaceId: namespace.id, id: secret.id } },
    driverId: "credential-gateway-contract",
    state: "ready",
    createdAt,
  };
  const account = {
    id: identifier("sa"),
    namespaceId: namespace.id,
    name: "Bound " + randomUUID(),
  };
  const role = {
    id: identifier("role"),
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "configuration" }],
  };
  const bindingOn = (resourceKind, resourceId) => ({
    id: identifier("binding"),
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind,
    resourceId,
  });
  const surviving = bindingOn("configuration", agentConfiguration.id);

  await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(namespace);
    await transaction.configurations.createConfiguration(agentConfiguration);
    await transaction.secrets.createSecret(agentSecret);
    await transaction.secrets.createSecret(secret);
    await transaction.configurations.createConfiguration(configuration);
    await transaction.configurations.createConfiguration(secondConfiguration);
    await transaction.agents.createAgent(agent);
    await transaction.revisions.createRevision({
      ...revision,
      id: identifier("rev"),
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agentConfiguration.id,
      servicePrincipalId: agent.servicePrincipalId,
      harnessAuth: { ...agent.harnessAuth, secretDriverId: agentSecret.driverId },
    });
    await transaction.presets.createPreset(preset);
    await transaction.credentialSources.createCredentialSource(source);
    await transaction.serviceAccounts.createServiceAccount(account);
    await transaction.iamPolicy.createRole(role);
    for (const binding of [
      bindingOn("configuration", configuration.id),
      bindingOn("preset", preset.id),
      bindingOn("secret", secret.id),
      bindingOn("credential_source", source.id),
      bindingOn("service_account", account.id),
      surviving,
    ]) {
      await transaction.iamPolicy.createAccessBinding(binding);
    }
  });

  // Each reference comes back once, ordered by kind then ID; a full page says more exist.
  const references = [
    ...configurationIds.map((id) => ({ kind: "configuration", id })),
    { kind: "credential_source", id: source.id },
  ];
  await store.read(async (state) => {
    assert.deepEqual(await state.secrets.listReferences(namespace.id, secret.id, 50), {
      references,
      truncated: false,
    });
    // A page that holds exactly every reference is not truncated.
    assert.deepEqual(await state.secrets.listReferences(namespace.id, secret.id, 3), {
      references,
      truncated: false,
    });
    assert.deepEqual(await state.secrets.listReferences(namespace.id, secret.id, 1), {
      references: [references[0]],
      truncated: true,
    });
    assert.deepEqual(await state.secrets.listReferences(namespace.id, agentSecret.id, 50), {
      references: [{ kind: "agent", id: agent.id }],
      truncated: false,
    });
  });

  // The credential source and the Configuration reference the Secret, so they go first.
  await store.transact(async (transaction) => {
    assert.equal(
      await transaction.credentialSources.deleteCredentialSource(namespace.id, source.id),
      true,
    );
    for (const id of configurationIds) {
      assert.equal(await transaction.configurations.deleteConfiguration(namespace.id, id), true);
    }
    assert.equal(await transaction.secrets.deleteSecret(namespace.id, secret.id), true);
    assert.equal(await transaction.presets.deletePreset(namespace.id, preset.id), true);
    assert.equal(
      await transaction.serviceAccounts.deleteServiceAccount(namespace.id, account.id),
      true,
    );
  });

  await store.read(async (state) => {
    assert.deepEqual(await state.iamPolicy.listAccessBindings(namespace.id), [surviving]);
  });
  // Only the binding on a live resource still holds the Role.
  await assert.rejects(
    store.transact((transaction) => transaction.iamPolicy.deleteRole(namespace.id, role.id)),
    /referenced by AccessBindings/,
  );
  await store.transact(async (transaction) => {
    assert.equal(await transaction.iamPolicy.deleteAccessBinding(namespace.id, surviving.id), true);
    assert.equal(await transaction.iamPolicy.deleteRole(namespace.id, role.id), true);
  });

  // A Namespace ServicePrincipal is listed and read only in its own Namespace. The Agent's
  // own ServicePrincipal is not a Namespace ServicePrincipal, so it is never listed or read.
  const principal = { kind: "service_principal", id: identifier("spn"), namespaceId: namespace.id };
  await store.transact((transaction) => transaction.iamPolicy.createServicePrincipal(principal));
  const otherNamespaceId = identifier("ns");
  await store.read(async (state) => {
    assert.deepEqual(await state.iamPolicy.listServicePrincipals(namespace.id), [principal]);
    assert.deepEqual(
      await state.iamPolicy.getServicePrincipal(namespace.id, principal.id),
      principal,
    );
    assert.equal(
      await state.iamPolicy.getServicePrincipal(namespace.id, agent.servicePrincipalId),
      undefined,
    );
    assert.deepEqual(await state.iamPolicy.listServicePrincipals(otherNamespaceId), []);
    assert.equal(
      await state.iamPolicy.getServicePrincipal(otherNamespaceId, principal.id),
      undefined,
    );
  });
}

async function verifyCredentialSourceContract(
  store,
  { namespace, harnessSecret, accountNamespace, accountConfiguration, accountAgent, revision },
) {
  const sourceNamespace = {
    id: identifier("ns"),
    name: "Credential sources " + randomUUID(),
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  const sourceConfiguration = {
    id: identifier("cfg"),
    namespaceId: sourceNamespace.id,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  };
  const sourceSecret = {
    id: identifier("sec"),
    namespaceId: sourceNamespace.id,
    name: "Gateway input " + randomUUID(),
    driverId: "secret-contract",
    backendRef: {
      namespaceName: "contract",
      name: "gateway-input",
      key: "value",
      uid: randomUUID(),
    },
    createdAt: new Date().toISOString(),
  };
  const source = {
    id: identifier("cs"),
    namespaceId: sourceNamespace.id,
    name: "OpenAI gateway " + randomUUID(),
    type: "openai",
    config: { base_url: "https://api.openai.com/v1" },
    secrets: {
      api_key: { kind: "secret", namespaceId: sourceNamespace.id, id: sourceSecret.id },
    },
    driverId: "credential-gateway-contract",
    state: "ready",
    createdAt: new Date().toISOString(),
  };
  const sourceBinding = { method: "credential_source", sourceId: source.id };
  const sourceAgent = {
    id: identifier("agt"),
    namespaceId: sourceNamespace.id,
    name: "Credential source agent " + randomUUID(),
    configurationId: sourceConfiguration.id,
    backendId: null,
    harnessAuth: sourceBinding,
    // The list holds every bound source; harnessAuth names the listed Harness source.
    credentialSources: [{ sourceId: source.id }],
    executionMode: "embedded",
    servicePrincipalId: identifier("service-agent"),
    desiredRuntimeState: "stopped",
    status: "active",
    createdAt: new Date().toISOString(),
  };
  const sourceRevision = {
    ...revision,
    id: identifier("rev"),
    namespaceId: sourceNamespace.id,
    agentId: sourceAgent.id,
    configurationId: sourceConfiguration.id,
    configurationGeneration: sourceConfiguration.generation,
    servicePrincipalId: sourceAgent.servicePrincipalId,
    harnessAuth: {
      ...sourceBinding,
      credentialGatewayId: "openshell-contract",
      sourceType: source.type,
      loginMode: "api_key",
    },
    credentialSources: [
      { sourceId: source.id, credentialGatewayId: "openshell-contract", sourceType: source.type },
    ],
  };
  const sourceReferences = (transaction) =>
    transaction.credentialSources.hasReferences(sourceNamespace.id, source.id);

  await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(sourceNamespace);
    await transaction.configurations.createConfiguration(sourceConfiguration);
    await transaction.secrets.createSecret(sourceSecret);
    assert.equal(await transaction.namespaces.hasCredentialSources(sourceNamespace.id), false);
    assert.deepEqual(await transaction.credentialSources.createCredentialSource(source), source);
    assert.equal(await transaction.namespaces.hasCredentialSources(sourceNamespace.id), true);
    assert.deepEqual(
      await transaction.credentialSources.lockCredentialSource(sourceNamespace.id, source.id),
      source,
    );
  });

  await store.read(async (state) => {
    // Secret inputs round-trip as exact same-Namespace references, never values.
    assert.deepEqual(
      await state.credentialSources.findCredentialSource(sourceNamespace.id, source.id),
      source,
    );
    assert.deepEqual(await state.credentialSources.listCredentialSources(sourceNamespace.id), [
      source,
    ]);
    assert.equal(
      await state.credentialSources.findCredentialSource(namespace.id, source.id),
      undefined,
      "A credential source cannot be read from another Namespace.",
    );
    assert.deepEqual(await state.credentialSources.listCredentialSources(namespace.id), []);
  });

  await assert.rejects(
    store.transact((transaction) =>
      transaction.credentialSources.createCredentialSource({ ...source, id: identifier("cs") }),
    ),
    {
      name: "ResourceStateConflictError",
      message:
        "A credential source with this name already exists in this Namespace. Choose a different name.",
    },
    "Credential source names must be unique within their Namespace.",
  );
  await assert.rejects(
    store.transact((transaction) =>
      transaction.credentialSources.createCredentialSource({
        ...source,
        id: identifier("cs"),
        name: "Foreign input " + randomUUID(),
        secrets: {
          api_key: { kind: "secret", namespaceId: sourceNamespace.id, id: harnessSecret.id },
        },
      }),
    ),
    storeRefusal(
      "ScopeViolationError",
      "The credential source references an unavailable Secret.",
      postgresOwnershipViolation,
    ),
    "A credential source cannot use a Secret owned by another Namespace.",
  );

  // Names are Namespace-scoped; a source without Secret inputs is valid.
  const namesakeSource = {
    ...source,
    id: identifier("cs"),
    namespaceId: accountNamespace.id,
    config: {},
    secrets: {},
  };
  await store.transact(async (transaction) => {
    assert.deepEqual(
      await transaction.credentialSources.createCredentialSource(namesakeSource),
      namesakeSource,
    );
  });

  // Registration is recorded before the gateway write: a registering source becomes ready
  // exactly once, may instead move to deleting, and never returns to registering.
  const registeringSource = {
    ...namesakeSource,
    id: identifier("cs"),
    name: "Registering gateway " + randomUUID(),
    state: "registering",
  };
  const abandonedSource = {
    ...registeringSource,
    id: identifier("cs"),
    name: "Abandoned gateway " + randomUUID(),
  };
  await store.transact(async (transaction) => {
    await transaction.credentialSources.createCredentialSource(registeringSource);
    await transaction.credentialSources.createCredentialSource(abandonedSource);
    assert.deepEqual(
      await transaction.credentialSources.markCredentialSourceReady(
        accountNamespace.id,
        registeringSource.id,
      ),
      { ...registeringSource, state: "ready" },
    );
    assert.equal(
      await transaction.credentialSources.markCredentialSourceReady(
        accountNamespace.id,
        registeringSource.id,
      ),
      undefined,
    );
    assert.deepEqual(
      await transaction.credentialSources.markCredentialSourceDeleting(
        accountNamespace.id,
        abandonedSource.id,
      ),
      { ...abandonedSource, state: "deleting" },
    );
    assert.equal(
      await transaction.credentialSources.markCredentialSourceReady(
        accountNamespace.id,
        abandonedSource.id,
      ),
      undefined,
    );
    for (const { id } of [registeringSource, abandonedSource]) {
      assert.equal(
        await transaction.credentialSources.deleteCredentialSource(accountNamespace.id, id),
        true,
      );
    }
  });

  // A registered source keeps its Secret inputs; deleting one would strand the gateway copy.
  await store.transact(async (transaction) => {
    assert.equal(
      await transaction.secrets.hasReferences(sourceNamespace.id, sourceSecret.id),
      true,
    );
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.secrets.deleteSecret(sourceNamespace.id, sourceSecret.id),
    ),
    { name: "ScopeViolationError", message: "The Secret is referenced by active platform state." },
    "A Secret used by a credential source cannot be deleted.",
  );

  await store.transact(async (transaction) => {
    assert.equal(await sourceReferences(transaction), false);
    await transaction.agents.createAgent(sourceAgent);
    // The Agent draft binding alone retains the source.
    assert.equal(await sourceReferences(transaction), true);
    assert.deepEqual(await transaction.revisions.createRevision(sourceRevision), sourceRevision);
    await transaction.agents.updateConfiguration(
      sourceNamespace.id,
      sourceAgent.id,
      sourceConfiguration.id,
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
    // An inactive historical snapshot does not retain the source.
    assert.equal(await sourceReferences(transaction), false);
    await transaction.agents.compareAndSetActiveRevision(
      sourceNamespace.id,
      sourceAgent.id,
      undefined,
      sourceRevision.id,
    );
    assert.equal(await sourceReferences(transaction), true);
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.credentialSources.deleteCredentialSource(sourceNamespace.id, source.id),
    ),
    {
      name: "ScopeViolationError",
      message: "The credential source is referenced by active platform state.",
    },
    "An active revision's credential source cannot be deleted.",
  );
  const blocking = (transaction) =>
    transaction.credentialSources.findBlockingReference(sourceNamespace.id, source.id);
  // Queued withdrawal work for a revision that held the source blocks deletion on its own, and
  // is reported as such so the refusal can say that only waiting helps. Rolled back.
  const rollback = new Error("roll back the withdrawal-only case");
  await assert.rejects(
    store.transact(async (transaction) => {
      await transaction.agents.compareAndClearActiveRevision(
        sourceNamespace.id,
        sourceAgent.id,
        sourceRevision.id,
      );
      await transaction.operations.append({
        kind: "agent_revision",
        action: "reconcile",
        target: "credentials_withdrawn",
        operationId: "withdrawal-blocking-contract",
        namespaceId: sourceNamespace.id,
        resourceId: sourceRevision.id,
        actorId: "principal-platform-state-contract",
      });
      assert.equal(await sourceReferences(transaction), true);
      assert.equal(await blocking(transaction), "withdrawal_work");
      throw rollback;
    }),
    (error) => error === rollback,
  );
  await store.transact(async (transaction) => {
    await transaction.agents.compareAndClearActiveRevision(
      sourceNamespace.id,
      sourceAgent.id,
      sourceRevision.id,
    );
    assert.equal(await sourceReferences(transaction), false);
    assert.equal(await blocking(transaction), undefined);
    // A queued deployment will attach the source, so it must survive until that work settles.
    await transaction.operations.append({
      kind: "agent_revision",
      action: "reconcile",
      namespaceId: sourceNamespace.id,
      resourceId: sourceRevision.id,
      actorId: "principal-platform-state-contract",
    });
    assert.equal(await sourceReferences(transaction), true);
    assert.equal(await blocking(transaction), "reference");
    assert.equal(
      await transaction.credentialSources.hasReferences(accountNamespace.id, source.id),
      false,
    );
  });

  // A withdrawal is keyed by revision and source: replays return the recorded request, and
  // revocation is recorded once.
  const withdrawal = {
    namespaceId: sourceNamespace.id,
    agentId: sourceAgent.id,
    revisionId: sourceRevision.id,
    credentialSourceId: source.id,
    state: "pending",
    requestedBy: "principal-platform-state-contract",
    requestedAt: new Date().toISOString(),
  };
  await store.transact(async (transaction) => {
    assert.deepEqual(
      await transaction.credentialSources.requestCredentialWithdrawal(withdrawal),
      withdrawal,
    );
    assert.deepEqual(
      await transaction.credentialSources.requestCredentialWithdrawal({
        ...withdrawal,
        requestedBy: "principal-platform-state-replay",
        requestedAt: new Date(Date.now() + 1000).toISOString(),
      }),
      withdrawal,
    );
    // Withdrawal work targets the revision without replacing its deployment work.
    await transaction.operations.append({
      kind: "agent_revision",
      action: "reconcile",
      target: "credentials_withdrawn",
      operationId: "withdrawal-contract",
      namespaceId: sourceNamespace.id,
      resourceId: sourceRevision.id,
      actorId: "principal-platform-state-contract",
    });
  });
  await store.read(async (state) => {
    assert.deepEqual(
      await state.credentialSources.listCredentialWithdrawals(
        sourceNamespace.id,
        sourceRevision.id,
      ),
      [withdrawal],
    );
    const revisionWork = (await state.operations.list()).filter(
      (operation) =>
        operation.kind === "agent_revision" && operation.resourceId === sourceRevision.id,
    );
    assert.deepEqual(revisionWork.map(({ target }) => target ?? "deploy").sort(), [
      "credentials_withdrawn",
      "deploy",
    ]);
    const work = await state.operations.findWork(
      `agent_revision:${sourceRevision.id}:reconcile:credentials_withdrawn:withdrawal-contract`,
    );
    assert.equal(work.agentTarget, "credentials_withdrawn");
    assert.equal(work.revisionId, sourceRevision.id);
    const deployment = await state.operations.findWork(
      `agent_revision:${sourceRevision.id}:reconcile`,
    );
    assert.equal(deployment.agentTarget, undefined);
  });
  // A pending withdrawal can be reassigned to the operator whose replay queues its next attempt;
  // it keeps the first request's time.
  await store.transact(async (transaction) => {
    assert.deepEqual(
      await transaction.credentialSources.reassignCredentialWithdrawal(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        "principal-platform-state-replay",
      ),
      { ...withdrawal, requestedBy: "principal-platform-state-replay" },
    );
    // The worker reads the stored requester, so the reassignment must persist.
    assert.deepEqual(
      await transaction.credentialSources.listCredentialWithdrawals(
        sourceNamespace.id,
        sourceRevision.id,
      ),
      [{ ...withdrawal, requestedBy: "principal-platform-state-replay" }],
    );
    // A blank requester is refused; the worker would have no principal to authorize. Pinned on
    // a pending withdrawal, the only kind the controller reassigns.
    await assert.rejects(
      transaction.credentialSources.reassignCredentialWithdrawal(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        "",
      ),
      { name: "ScopeViolationError", message: "A credential withdrawal requester is missing." },
    );
    assert.deepEqual(
      await transaction.credentialSources.reassignCredentialWithdrawal(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        withdrawal.requestedBy,
      ),
      withdrawal,
    );
  });
  const completedAt = new Date().toISOString();
  const attempted = {
    ...withdrawal,
    lastReason: "CREDENTIAL_WITHDRAWAL_PENDING",
    lastAttemptAt: completedAt,
  };
  await store.transact(async (transaction) => {
    // The worker's latest outcome is recorded on the pending withdrawal it explains.
    assert.deepEqual(
      await transaction.credentialSources.recordCredentialWithdrawalAttempt(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        { reason: "CREDENTIAL_WITHDRAWAL_PENDING", at: completedAt },
      ),
      attempted,
    );
    assert.deepEqual(
      await transaction.credentialSources.markCredentialWithdrawalRevoked(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        completedAt,
      ),
      { ...attempted, state: "revoked", completedAt },
    );
    assert.equal(
      await transaction.credentialSources.recordCredentialWithdrawalAttempt(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        { reason: "CREDENTIALS_WITHDRAWN", at: completedAt },
      ),
      undefined,
    );
    assert.equal(
      await transaction.credentialSources.markCredentialWithdrawalRevoked(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        completedAt,
      ),
      undefined,
    );
    // A revoked withdrawal keeps the requester whose authority revoked it.
    assert.equal(
      await transaction.credentialSources.reassignCredentialWithdrawal(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        "principal-platform-state-replay",
      ),
      undefined,
    );
  });

  // An update may point the existing field at a replacement Secret, but never change fields.
  const replacementSecret = {
    ...sourceSecret,
    id: identifier("sec"),
    name: "Replacement model key " + randomUUID(),
    backendRef: { ...sourceSecret.backendRef, name: "replacement-model-key", uid: randomUUID() },
  };
  const replacementRef = {
    kind: "secret",
    namespaceId: sourceNamespace.id,
    id: replacementSecret.id,
  };
  await store.transact(async (transaction) => {
    await transaction.secrets.createSecret(replacementSecret);
    assert.deepEqual(
      await transaction.credentialSources.replaceCredentialSourceSecrets(
        sourceNamespace.id,
        source.id,
        { api_key: replacementRef },
      ),
      { ...source, secrets: { api_key: replacementRef } },
    );
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.credentialSources.replaceCredentialSourceSecrets(sourceNamespace.id, source.id, {
        other_key: replacementRef,
      }),
    ),
    { name: "ScopeViolationError", message: "Credential source Secret fields cannot change." },
    "A credential source update cannot change its Secret fields.",
  );
  // Restore the original reference so later cases keep their Secret dependency.
  await store.transact((transaction) =>
    transaction.credentialSources.replaceCredentialSourceSecrets(sourceNamespace.id, source.id, {
      api_key: { kind: "secret", namespaceId: sourceNamespace.id, id: sourceSecret.id },
    }),
  );

  // A non-model source binds through the Agent's credentialSources list. The draft and the
  // active revision each retain it, and a revision freezes exactly the draft's list.
  const tokenSource = {
    ...source,
    id: identifier("cs"),
    name: "Registry token " + randomUUID(),
    type: "bearer-token",
    config: { host: "registry.example.com", env_var: "REGISTRY_TOKEN" },
    secrets: { token: { kind: "secret", namespaceId: sourceNamespace.id, id: sourceSecret.id } },
  };
  const toolAgent = {
    ...sourceAgent,
    id: identifier("agt"),
    name: "Credential source tool agent " + randomUUID(),
    harnessAuth: { method: "runtime" },
    credentialSources: [{ sourceId: tokenSource.id }],
    servicePrincipalId: identifier("service-agent"),
  };
  const toolRevision = {
    ...sourceRevision,
    id: identifier("rev"),
    agentId: toolAgent.id,
    servicePrincipalId: toolAgent.servicePrincipalId,
    harnessAuth: { method: "runtime" },
    credentialSources: [
      {
        sourceId: tokenSource.id,
        credentialGatewayId: "openshell-contract",
        sourceType: tokenSource.type,
      },
    ],
  };
  const tokenReferences = (transaction) =>
    transaction.credentialSources.hasReferences(sourceNamespace.id, tokenSource.id);
  await store.transact(async (transaction) => {
    await transaction.credentialSources.createCredentialSource(tokenSource);
    await transaction.agents.createAgent(toolAgent);
    assert.deepEqual(
      (await transaction.agents.findAgent(sourceNamespace.id, toolAgent.id)).credentialSources,
      [{ sourceId: tokenSource.id }],
    );
    assert.equal(await tokenReferences(transaction), true);
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.revisions.createRevision({ ...toolRevision, credentialSources: undefined }),
    ),
    "A revision must freeze the Agent's non-model sources.",
  );
  await assert.rejects(
    store.transact((transaction) =>
      transaction.credentialSources.deleteCredentialSource(sourceNamespace.id, tokenSource.id),
    ),
    "An Agent draft's non-model source cannot be deleted.",
  );
  await store.transact(async (transaction) => {
    assert.deepEqual(await transaction.revisions.createRevision(toolRevision), toolRevision);
    await transaction.agents.compareAndSetActiveRevision(
      sourceNamespace.id,
      toolAgent.id,
      undefined,
      toolRevision.id,
    );
    // An empty list removes the draft binding; the active revision still retains the source.
    const cleared = await transaction.agents.updateConfiguration(
      sourceNamespace.id,
      toolAgent.id,
      sourceConfiguration.id,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
    assert.equal(cleared.credentialSources, undefined);
    assert.equal(await tokenReferences(transaction), true);
    await transaction.agents.compareAndClearActiveRevision(
      sourceNamespace.id,
      toolAgent.id,
      toolRevision.id,
    );
    assert.equal(await tokenReferences(transaction), false);
    // Queued work for a revision that froze the source will attach it.
    await transaction.operations.append({
      kind: "agent_revision",
      action: "reconcile",
      namespaceId: sourceNamespace.id,
      resourceId: toolRevision.id,
      actorId: "principal-platform-state-contract",
    });
    assert.equal(await tokenReferences(transaction), true);
  });

  // The store keeps a draft's list exact: every entry names a source in the Agent's Namespace,
  // and a credential-source Harness binding names a listed one.
  const secondToken = {
    ...tokenSource,
    id: identifier("cs"),
    name: "Second token " + randomUUID(),
  };
  const missingSourceId = identifier("cs");
  const listedAgent = {
    ...toolAgent,
    id: identifier("agt"),
    name: "Credential source listed agent " + randomUUID(),
    servicePrincipalId: identifier("service-agent"),
  };
  await store.transact((transaction) =>
    transaction.credentialSources.createCredentialSource(secondToken),
  );
  for (const [agent, why] of [
    [
      { ...listedAgent, credentialSources: [{ sourceId: missingSourceId }] },
      "A draft cannot list a missing source.",
    ],
    [
      {
        ...listedAgent,
        harnessAuth: sourceBinding,
        credentialSources: [{ sourceId: tokenSource.id }],
      },
      "A draft's Harness source must be listed.",
    ],
  ]) {
    await assert.rejects(
      store.transact((transaction) => transaction.agents.createAgent(agent)),
      { name: "ScopeViolationError" },
      why,
    );
  }
  const updateList = (credentialSources, harnessAuth) =>
    store.transact((transaction) =>
      transaction.agents.updateConfiguration(
        sourceNamespace.id,
        listedAgent.id,
        sourceConfiguration.id,
        undefined,
        harnessAuth,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        credentialSources,
      ),
    );
  await store.transact((transaction) => transaction.agents.createAgent(listedAgent));
  await assert.rejects(
    updateList([{ sourceId: missingSourceId }]),
    { name: "ScopeViolationError" },
    "An update cannot list a missing source.",
  );
  // An update that leaves the list out keeps it.
  assert.deepEqual((await updateList(undefined, { method: "runtime" })).credentialSources, [
    { sourceId: tokenSource.id },
  ]);
  assert.deepEqual(
    (await updateList([{ sourceId: secondToken.id }, { sourceId: tokenSource.id }]))
      .credentialSources,
    [{ sourceId: secondToken.id }, { sourceId: tokenSource.id }],
  );

  // A revision freezes exactly the draft's list, in order, as well-formed snapshots.
  const snapshot = (sourceId) => ({
    sourceId,
    credentialGatewayId: "openshell-contract",
    sourceType: tokenSource.type,
  });
  const listedRevision = {
    ...toolRevision,
    id: identifier("rev"),
    agentId: listedAgent.id,
    servicePrincipalId: listedAgent.servicePrincipalId,
    credentialSources: [snapshot(secondToken.id), snapshot(tokenSource.id)],
  };
  for (const [credentialSources, why] of [
    [[snapshot(tokenSource.id), snapshot(secondToken.id)], "out of order"],
    [[...listedRevision.credentialSources, snapshot(missingSourceId)], "with an extra source"],
    [
      [{ ...snapshot(secondToken.id), driverId: "elsewhere" }, snapshot(tokenSource.id)],
      "with an extra field",
    ],
    [
      [{ ...snapshot(secondToken.id), credentialGatewayId: "" }, snapshot(tokenSource.id)],
      "without a gateway",
    ],
  ]) {
    await assert.rejects(
      store.transact((transaction) =>
        transaction.revisions.createRevision({ ...listedRevision, credentialSources }),
      ),
      { name: "ScopeViolationError" },
      `A revision cannot freeze the draft's sources ${why}.`,
    );
  }
  await store.transact(async (transaction) => {
    assert.deepEqual(await transaction.revisions.createRevision(listedRevision), listedRevision);
  });
  // A draft without sources freezes none: an empty snapshot list is not a valid form of that.
  const unlistedAgent = {
    ...listedAgent,
    id: identifier("agt"),
    name: "Credential source unlisted agent " + randomUUID(),
    credentialSources: undefined,
    servicePrincipalId: identifier("service-agent"),
  };
  await store.transact((transaction) => transaction.agents.createAgent(unlistedAgent));
  await assert.rejects(
    store.transact((transaction) =>
      transaction.revisions.createRevision({
        ...listedRevision,
        id: identifier("rev"),
        agentId: unlistedAgent.id,
        servicePrincipalId: unlistedAgent.servicePrincipalId,
        credentialSources: [],
      }),
    ),
    { name: "ScopeViolationError" },
    "A revision cannot freeze an empty source list.",
  );

  // An update that leaves harnessAuth out keeps the stored binding without checking it again;
  // only a supplied binding must be available. Here the bound source is already deleting.
  const staleSource = {
    ...source,
    id: identifier("cs"),
    name: "Stale Harness source " + randomUUID(),
  };
  const staleBinding = { method: "credential_source", sourceId: staleSource.id };
  const staleAgent = {
    ...sourceAgent,
    id: identifier("agt"),
    name: "Stale Harness source agent " + randomUUID(),
    harnessAuth: staleBinding,
    credentialSources: [{ sourceId: staleSource.id }],
    servicePrincipalId: identifier("service-agent"),
  };
  await store.transact(async (transaction) => {
    await transaction.credentialSources.createCredentialSource(staleSource);
    await transaction.agents.createAgent(staleAgent);
    assert.equal(
      (
        await transaction.credentialSources.markCredentialSourceDeleting(
          sourceNamespace.id,
          staleSource.id,
        )
      ).state,
      "deleting",
    );
  });
  const kept = await store.transact((transaction) =>
    transaction.agents.updateConfiguration(
      sourceNamespace.id,
      staleAgent.id,
      sourceConfiguration.id,
      "dedicated",
    ),
  );
  assert.deepEqual(
    {
      executionMode: kept.executionMode,
      harnessAuth: kept.harnessAuth,
      credentialSources: kept.credentialSources,
    },
    {
      executionMode: "dedicated",
      harnessAuth: staleBinding,
      credentialSources: staleAgent.credentialSources,
    },
    "Omitting harnessAuth keeps the stored binding without checking it again.",
  );
  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.updateConfiguration(
        sourceNamespace.id,
        staleAgent.id,
        sourceConfiguration.id,
        undefined,
        staleBinding,
      ),
    ),
    {
      name: "ScopeViolationError",
      message: "The Agent harness authentication references an unavailable credential source.",
    },
    "Supplying the same binding again checks it.",
  );
  const detached = await store.transact((transaction) =>
    transaction.agents.updateConfiguration(
      sourceNamespace.id,
      staleAgent.id,
      sourceConfiguration.id,
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    ),
  );
  assert.deepEqual(
    { harnessAuth: detached.harnessAuth, credentialSources: detached.credentialSources },
    { harnessAuth: null, credentialSources: undefined },
  );

  // Deletion is two-phase: a deleting source stays recorded and blocks Namespace
  // teardown, but new bindings refuse it.
  await store.transact(async (transaction) => {
    const deleting = await transaction.credentialSources.markCredentialSourceDeleting(
      accountNamespace.id,
      namesakeSource.id,
    );
    assert.deepEqual(deleting, { ...namesakeSource, state: "deleting" });
    assert.equal(
      await transaction.credentialSources.markCredentialSourceDeleting(
        accountNamespace.id,
        namesakeSource.id,
      ),
      undefined,
    );
    assert.equal(await transaction.namespaces.hasCredentialSources(accountNamespace.id), true);
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.updateConfiguration(
        accountNamespace.id,
        accountAgent.id,
        accountConfiguration.id,
        undefined,
        { method: "credential_source", sourceId: namesakeSource.id },
      ),
    ),
    {
      name: "ScopeViolationError",
      message: "The Agent harness authentication references an unavailable credential source.",
    },
    "A deleting credential source cannot be newly bound.",
  );
  await store.transact(async (transaction) => {
    assert.equal(
      await transaction.credentialSources.deleteCredentialSource(
        accountNamespace.id,
        namesakeSource.id,
      ),
      true,
    );
    assert.equal(
      await transaction.credentialSources.findCredentialSource(
        accountNamespace.id,
        namesakeSource.id,
      ),
      undefined,
    );
    assert.equal(await transaction.namespaces.hasCredentialSources(accountNamespace.id), false);
    assert.equal(
      await transaction.credentialSources.deleteCredentialSource(
        accountNamespace.id,
        namesakeSource.id,
      ),
      false,
    );
  });
}
